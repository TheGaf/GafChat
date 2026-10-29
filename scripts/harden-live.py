#!/usr/bin/env python3
"""Install the pinned GafChat hardening release. No environment or private-state upload."""
import argparse,concurrent.futures,hashlib,json,os,pathlib,re,shutil,signal,stat,subprocess,sys,tempfile,time,urllib.request
from urllib.parse import urlsplit

RELEASE_REF = "b77caf95eb4a6eb9527eca7b027f90f7bd1e6ed0"
FILES = {'server.js': '1af9e47d155f0e9d6e5e6da6b3b45ba33f8955f26e178568d9b501389ab4ed7e', 'public/app.js': '5bcf913d801d9e1e92163a3cdbd35ac4af3542553d591f390837329a6672d544', 'public/index.html': '245732b5b246b9a7368b88fe3708cdd7cee5adb35bba3dbac7590166fd320406', 'public/styles.css': '3c79e4d95788bfd96de6a223d39444530443ce68e30a2a965daa5680d9d273f9', 'public/sw.js': '8aee3eee9446671356ee24bea2f19fdff576843a907757cdf61449bdb45865cb', 'package.json': 'efa47c80e13117e12125203572425083ade7ee8b1ab6eeb7402ed7d22cf6e2cf', 'package-lock.json': 'cdd4b6fa6d2c047d115504d3524858d49adac91eac04f275affe9351587f6355', '.env.example': '2488ae1cf92e3182216837206625108808a19fe5b1911cc6c4ee76653d6a569c', 'README.md': '8ab70f54e57c4e052b715e244b1f8d482b8e643af96bb2e8a2c46f1e51ee78f6', 'test/basic.test.js': 'db71970bb082ceede5e9d734fa7f0913fc6644178bdb2dcbd3d60f1770381b6d', 'test/hardening.test.js': 'b2bae127da98dda3fc24e552235896124f2e7706691b9cefabcc71cd77ed8fe9', 'public/manifest.json': 'c54e1b7635e951945203d3ee4a59285b94785719af98d01f374df26518cdd8e4', 'third_party/Titillium-Web-OFL.txt': '74a09413ee50672765c52b8356bc03b68b274bc926888b37bb9092c8dcba09fd', 'public/fonts/titillium-web-latin-300-normal.woff2': 'b6287de6fc5553c57520eedd963a16b66f3c192a2c65916243a0a92a8e0e8a8f', 'public/fonts/titillium-web-latin-400-normal.woff2': '861b80b49d2a634d8746e2e45c672309d9ba69a2fdd95da2af034d7a1d09b3f9', 'public/fonts/titillium-web-latin-600-normal.woff2': 'f356ff5613e1b6789a47ae3bd6b72fa6fb61d44493811bcb758fb4229b7a8bcb', 'public/fonts/titillium-web-latin-700-normal.woff2': '9e3162d81ed6681322ab34791660f1b45c79945197e7a7dbb217005b2926caf4'}
BASELINES = {'server.js': ['207887092ef65d5196628e5ab3054c2cf23fd46067dcf1d38904f4320de65956', '31c6972bd7bde25b7b1672e4f1b9e6736febb3eb565bf97cb7dbe762db386cb8', 'd5d65bfbd1ed0e237ba360f1ba6f35e0cd138f9c0e86808c6cac2aa58d6c3955'], 'public/app.js': ['ed3348fbdfdd11f5f98ad5f46003a8425f81de2a7ec0dc94330e8f95088911a3']}
SERVICE = "gafchat.service"

def run(args,**kwargs):
    return subprocess.run([str(x) for x in args],check=True,**kwargs)

def output(args):
    return run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True).stdout.strip()

def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()

def download(target,relative,expected):
    url=f"https://raw.githubusercontent.com/TheGaf/GafChat/{RELEASE_REF}/{relative}"
    data=None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url,timeout=30) as response:data=response.read(2500000)
            break
        except Exception:
            if attempt==2:raise RuntimeError(f"Could not download {relative}") from None
            time.sleep(1)
    if hashlib.sha256(data).hexdigest()!=expected:raise RuntimeError(f"Checksum mismatch: {relative}")
    file=target/relative;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(data)

def install_file(source,destination,uid,gid,mode):
    temporary=destination.with_name(destination.name+".hardening-install.tmp")
    run(["sudo","install","-D","-o",uid,"-g",gid,"-m",oct(mode)[2:],source,temporary])
    run(["sudo","mv","-T",temporary,destination])

def healthy(url,version):
    for _ in range(20):
        try:
            with urllib.request.urlopen(url,timeout=2) as response:data=json.load(response)
            if data.get("ok") and data.get("version")==version:return True
        except Exception:pass
        time.sleep(.5)
    return False

def baseline(app):
    version=json.loads((app/"package.json").read_text()).get("version")
    if version!="0.5.2":raise RuntimeError(f"Expected v0.5.2, found {version}. No files changed.")
    for relative,allowed in BASELINES.items():
        if digest(app/relative) not in allowed:raise RuntimeError(f"{relative} differs from the reviewed build. No files changed.")

def effective_origin(values,app):
    value=values.get("PUBLIC_ORIGIN")
    if not value:
        match=re.search(r'const PUBLIC_ORIGIN = String\(process\.env\.PUBLIC_ORIGIN \|\| "([^"]+)"\)',(app/"server.js").read_text())
        if not match:raise RuntimeError("Cannot determine the original public origin. No files changed.")
        value=match.group(1)
    parsed=urlsplit(value)
    if parsed.scheme not in ["http","https"] or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ["","/"] or parsed.query or parsed.fragment:
        raise RuntimeError("Invalid public origin. No files changed.")
    value=parsed.scheme+"://"+parsed.netloc
    if not re.fullmatch(r"https?://[A-Za-z0-9.:[\]-]+",value):raise RuntimeError("Unsupported public-origin syntax")
    return value

def browser_assets_healthy(health_url,origin):
    base=urlsplit(health_url)
    for asset in ["/app.js?v=053","/styles.css?v=053","/fonts/titillium-web-latin-400-normal.woff2"]:
        try:
            request=urllib.request.Request(base.scheme+"://"+base.netloc+asset,headers={"Origin":origin})
            with urllib.request.urlopen(request,timeout=3) as response:
                if response.status!=200:return False
                response.read()
        except Exception:return False
    return True

def sandbox(state_dirs,public_origin=None):
    # Writable exceptions contain private state only; application code stays read-only.
    paths=" ".join('"'+str(p).replace("%","%%")+'"' for p in state_dirs)
    origin_setting='Environment="PUBLIC_ORIGIN='+public_origin.replace("%","%%")+'"' if public_origin else ""
    return f"""[Service]
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
UMask=0077
ReadWritePaths={paths}
{origin_setting}
LimitNOFILE=1024
TasksMax=64
MemoryMax=1G
"""

def runtime_state(pid,app):
    # Return only storage paths. Credentials remain inside the existing service.
    code="""import json,pathlib,sys
data=pathlib.Path('/proc/'+sys.argv[1]+'/environ').read_bytes()
values={}
for item in data.split(b'\\0'):
 k,sep,v=item.partition(b'=')
 if k in [b'TRUST_DB',b'HOST_PUSH_FILE',b'PUBLIC_ORIGIN']:values[k.decode()]=v.decode()
print(json.dumps(values))
"""
    values=json.loads(output(["sudo","python3","-c",code,pid]))
    dirs=set()
    for key,name in [("TRUST_DB","trusted-devices.json"),("HOST_PUSH_FILE","host-push.json")]:
        file=pathlib.Path(values.get(key,str(app/name)))
        if not file.is_absolute():file=app/file
        file=file.resolve()
        if file==app or app in file.parents:
            raise RuntimeError(f"{key} still points inside the application. State isolation must be completed first. No files changed.")
        if not file.parent.is_dir():raise RuntimeError(f"Missing private state directory for {key}. No files changed.")
        if any(c in str(file.parent) for c in ['"','\\','\n','\r']):raise RuntimeError("Unsupported state-directory name")
        dirs.add(file.parent)
    return sorted(dirs),effective_origin(values,app)

def apply_release(app,payload,backup,node,dropin,dropin_text,health_url,public_origin=None):
    records={};applied=False
    for relative in FILES:
        target=app/relative
        if target.is_symlink() or any(p.is_symlink() for p in target.parents if p!=app and app in p.parents):raise RuntimeError(f"Refusing to overwrite symlink: {relative}")
        if target.exists():
            info=target.stat();records[relative]=(info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode))
            saved=backup/relative;saved.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(target,saved)
        else:records[relative]=None
    old_dropin=dropin.exists()
    if old_dropin:
        saved=output(["sudo","cat",dropin]);(backup/"previous-hardening.conf").write_text(saved+"\n")
    (backup/"rollback-manifest.json").write_text(json.dumps(records,indent=2))
    (backup/"new-hardening.conf").write_text(dropin_text)
    owner=(app/"server.js").stat()
    def interrupted(signum,frame):raise RuntimeError("Installation interrupted")
    previous={s:signal.signal(s,interrupted) for s in [signal.SIGINT,signal.SIGTERM,signal.SIGHUP]}
    try:
        applied=True
        # Tests have passed; stop before the short replacement window.
        run(["sudo","systemctl","stop",SERVICE])
        for relative in FILES:
            uid,gid,mode=records[relative] or (owner.st_uid,owner.st_gid,0o644)
            install_file(payload/relative,app/relative,uid,gid,mode)
        install_file(backup/"new-hardening.conf",dropin,0,0,0o644)
        run(["sudo","systemctl","daemon-reload"])
        run(["sudo","systemctl","restart",SERVICE])
        if not healthy(health_url,"0.5.3"):raise RuntimeError("The hardened service did not pass its health check")
        if public_origin and not browser_assets_healthy(health_url,public_origin):raise RuntimeError("Browser-origin asset checks failed")
        if output(["systemctl","is-active",SERVICE])!="active":raise RuntimeError("The service is not active")
    except BaseException:
        if applied:
            print("Installation failed; restoring the previous build.",flush=True)
            # Avoid a second terminal interruption halfway through restoration.
            for sig in previous:signal.signal(sig,signal.SIG_IGN)
            try:
                subprocess.run(["sudo","systemctl","stop",SERVICE],check=False)
                for relative,info in records.items():
                    if info:install_file(backup/relative,app/relative,*info)
                    else:run(["sudo","rm","-f",app/relative])
                    subprocess.run(["sudo","rm","-f",str(app/relative)+".hardening-install.tmp"],check=False)
                if old_dropin:install_file(backup/"previous-hardening.conf",dropin,0,0,0o644)
                else:run(["sudo","rm","-f",dropin])
                run(["sudo","systemctl","daemon-reload"])
                run(["sudo","systemctl","restart",SERVICE])
                if not healthy(health_url,"0.5.2"):raise RuntimeError("Previous service did not recover")
                print("Previous build restored and healthy.",flush=True)
            except BaseException:
                print(f"Automatic rollback could not finish. Backups: {backup}",file=sys.stderr,flush=True)
        raise
    finally:
        for sig,handler in previous.items():signal.signal(sig,handler)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-only",action="store_true",help="Stage and test without touching the service")
    parser.add_argument("--app-dir",type=pathlib.Path)
    parser.add_argument("--node",default=None)
    args=parser.parse_args()
    os.umask(0o077)
    app=(args.app_dir or pathlib.Path(output(["systemctl","show","-p","WorkingDirectory","--value",SERVICE]))).resolve()
    if not (app/"server.js").is_file():raise RuntimeError("GafChat application directory not found")
    baseline(app)
    if args.check_only:
        node=args.node or shutil.which("node");state_dirs=[]
    else:
        run(["sudo","-v"])
        if output(["systemctl","is-active",SERVICE])!="active":raise RuntimeError("GafChat must be running before this upgrade")
        user=output(["systemctl","show","-p","User","--value",SERVICE])
        if not user or user=="root":raise RuntimeError("GafChat needs its dedicated non-root service account first")
        pid=output(["systemctl","show","-p","MainPID","--value",SERVICE])
        node=args.node or output(["sudo","readlink","-f",f"/proc/{pid}/exe"])
        state_dirs,public_origin=runtime_state(pid,app)
        if not healthy("http://127.0.0.1:8787/api/health","0.5.2"):raise RuntimeError("The current service did not pass its pre-upgrade health check")
    major=int(output([node,"-p","process.versions.node.split('.')[0]"]))
    if major<22:raise RuntimeError("Node 22 or newer is required")
    with tempfile.TemporaryDirectory(prefix="gafchat-harden-") as temporary:
        stage=pathlib.Path(temporary)
        print("Downloading and verifying the pinned release.",flush=True)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            jobs=[pool.submit(download,stage,p,sha) for p,sha in FILES.items()]
            for job in jobs:job.result()
        (stage/"node_modules").symlink_to(app/"node_modules",target_is_directory=True)
        print("Running syntax and security regression checks before installation.",flush=True)
        for relative in ["server.js","public/app.js","public/sw.js"]:run([node,"--check",stage/relative])
        run([node,"--test"],cwd=stage)
        if args.check_only:
            print("Checks passed. No application or service files changed.")
            return
        parent=pathlib.Path.home()/"gafchat-backups";parent.mkdir(mode=0o700,exist_ok=True)
        if stat.S_IMODE(parent.stat().st_mode)&0o077:raise RuntimeError("Backup directory must be private (mode 700)")
        backup=pathlib.Path(tempfile.mkdtemp(prefix=time.strftime("hardening-%Y%m%d-%H%M%S-"),dir=parent))
        dropin=pathlib.Path("/etc/systemd/system/gafchat.service.d/40-hardening.conf")
        apply_release(app,stage,backup,node,dropin,sandbox(state_dirs,public_origin),"http://127.0.0.1:8787/api/health",public_origin=public_origin)
        print(f"ALL CLEAR: GafChat v0.5.3 is running. Backup: {backup}")
        print("Close and reopen GafChat on each device. Open rooms ended during the restart.")

if __name__=="__main__":
    try:main()
    except (Exception,KeyboardInterrupt) as e:
        # Avoid dumping environment variables, request contents or service configuration.
        print(f"STOP: {type(e).__name__}: {e}",file=sys.stderr);sys.exit(1)
