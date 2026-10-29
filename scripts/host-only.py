#!/usr/bin/env python3
"""Restrict room creation to Host logins, without changing secrets or guest trust."""
from pathlib import Path
import datetime,json,re,shutil,subprocess,tempfile,time,urllib.request

def run(args,**kw):return subprocess.run(args,check=True,**kw)
app=Path(run(["systemctl","show","-p","WorkingDirectory","--value","gafchat"],capture_output=True,text=True).stdout.strip())
changes={}
server=app/"server.js";source=server.read_text()
old="return isHost(req)||Boolean(trustedDevice(req));"
if old not in source and "function canCreateRoom(req){\n  return isHost(req);\n}" not in source:raise SystemExit("STOP: server authorization differs from the reviewed build")
changes[server]=source.replace(old,"return isHost(req);").replace('error:"Trusted device only."','error:"Host only."')
client=app/"public/app.js";source=client.read_text()
old='if(!(state.host||state.trusted))return err("Trusted device only.");'
new='if(!state.host)return err("Host only.");'
if old not in source and new not in source:raise SystemExit("STOP: client authorization differs from the reviewed build")
changes[client]=source.replace(old,new)
html=app/"public/index.html";changes[html]=re.sub(r'/app\.js\?v=\d+','/app.js?v=054',html.read_text())
for path in [server,client]:run(["node","--check","--input-type=module"],input=changes[path],text=True)
run(["sudo","-v"])
backup=Path(tempfile.mkdtemp(prefix="host-only-"+datetime.datetime.now().strftime("%Y%m%d-%H%M%S-"),dir=Path.home()/"gafchat-backups"))
for path in changes:
    saved=backup/path.relative_to(app);saved.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(path,saved)
try:
    for path,text in changes.items():path.write_text(text)
    run(["sudo","systemctl","restart","gafchat"])
    for attempt in range(20):
        try:
            with urllib.request.urlopen("http://127.0.0.1:8787/api/health",timeout=2) as response:assert json.load(response).get("ok")
            break
        except Exception:
            if attempt==19:raise
            time.sleep(.5)
except BaseException:
    for path in changes:shutil.copy2(backup/path.relative_to(app),path)
    run(["sudo","systemctl","restart","gafchat"])
    raise
print("ALL CLEAR: only Host logins can create rooms. Guest trust and secrets preserved.")
print("Backup:",backup)
print("Close and reopen GafChat on your devices.")
