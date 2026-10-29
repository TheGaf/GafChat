import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,readFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import {fileURLToPath} from "node:url";
import WebSocket from "ws";

const root=fileURLToPath(new URL("..",import.meta.url));
const secret="synthetic-test-secret-not-a-deployment-credential";
const origin="https://chat.example.test";
const wait=ms=>new Promise(r=>setTimeout(r,ms));

async function fixture(t,settings={}){
  const dir=await mkdtemp(path.join(tmpdir(),"gafchat-test-"));
  const child=spawn(process.execPath,["server.js"],{
    cwd:root,env:{PATH:process.env.PATH,PORT:"0",HOST_PASSWORD:"test-only-password",HOST_AUTH_SECRET:secret,
      PUBLIC_ORIGIN:origin,TRUST_DB:path.join(dir,"trusted.json"),HOST_PUSH_FILE:path.join(dir,"push.json"),...settings},
    stdio:["ignore","pipe","pipe"]
  });
  let logs="";child.stderr.on("data",b=>{logs+=b});
  t.after(async()=>{if(child.exitCode===null){const end=new Promise(r=>child.once("exit",r));child.kill();await end}await rm(dir,{recursive:true,force:true})});
  const port=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("Startup timeout: "+logs)),5000);
    child.stdout.on("data",b=>{const m=b.toString().match(/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);resolve(Number(m[1]))}});
    child.once("exit",()=>{clearTimeout(timer);reject(new Error("Startup failed: "+logs))});
  });
  const base=`http://127.0.0.1:${port}`;
  async function request(route,{body,headers={},method=body===undefined?"GET":"POST"}={}){
    const res=await fetch(base+route,{method,headers:{...(body!==undefined?{"Content-Type":"application/json"}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    const text=await res.text();let data;try{data=JSON.parse(text)}catch{data=text}
    return {status:res.status,data,headers:res.headers};
  }
  const login=await request("/api/host/login",{body:{password:"test-only-password"}});
  assert.equal(login.status,200);const cookie=login.headers.get("set-cookie").split(";")[0];
  const owner=async()=>{const r=await request("/api/rooms",{body:{name:"Owner"},headers:{Cookie:cookie}});assert.equal(r.status,201);return r.data};
  const join=async room=>{const r=await request(`/api/rooms/${room.room}/join`,{body:{name:"Guest",inviteToken:room.inviteToken}});assert.equal(r.status,200);return r.data};
  return {base,port,dir,request,cookie,owner,join,login};
}

function connect(f,room,token,options={}){
  const ws=new WebSocket(f.base.replace("http:","ws:")+`/ws?room=${room}`,["gafchat",`auth.${token}`],{origin,...options});
  const messages=[];ws.on("message",b=>messages.push(JSON.parse(b.toString())));
  const ready=new Promise((resolve,reject)=>{ws.once("open",()=>resolve(ws));ws.once("error",reject)});
  return {ws,messages,ready};
}
async function until(fn){for(let i=0;i<100;i++){const value=fn();if(value)return value;await wait(20)}throw new Error("Condition timeout")}
function token(payload){const body=Buffer.from(JSON.stringify(payload)).toString("base64url");return body+"."+crypto.createHmac("sha256",secret).update(body).digest("base64url")}

test("rejects foreign origins, form posts, malformed JSON and invalid host claims",async t=>{
  const f=await fixture(t);
  assert.match(f.login.headers.get("set-cookie"),/Max-Age=2592000/);
  assert.equal((await f.request("/api/rooms",{body:{name:"X"},headers:{Cookie:f.cookie,Origin:"https://other.example"}})).status,403);
  assert.equal((await fetch(f.base+"/api/host/login",{method:"POST",headers:{"Content-Type":"text/plain"},body:"{}"})).status,415);
  assert.equal((await f.request("/api/rooms",{body:null,headers:{Cookie:f.cookie}})).status,400);
  assert.equal((await f.request("/api/host/status",{headers:{Cookie:"broken=%ZZ"}})).status,200);
  const now=Math.floor(Date.now()/1000);
  for(const payload of [{iat:now},{iat:now-31*86400,exp:now+86400}]){
    const r=await f.request("/api/host/status",{headers:{Cookie:"gafchat_host="+token(payload)}});assert.equal(r.data.host,false);
  }
  assert.equal((await f.request("/api/rooms",{body:{name:"Untrusted"}})).status,403);
});

test("room access credentials use headers and WebSocket subprotocol, with encrypted relay intact",async t=>{
  const f=await fixture(t),room=await f.owner(),guest=await f.join(room);
  assert.equal((await f.request(`/api/rooms/${room.room}/status?token=${room.token}`)).status,404);
  assert.equal((await f.request(`/api/rooms/${room.room}/status`,{headers:{Authorization:`Bearer ${room.token}`}})).status,200);
  const a=connect(f,room.room,room.token),b=connect(f,room.room,guest.token);t.after(()=>{a.ws.terminate();b.ws.terminate()});
  await Promise.all([a.ready,b.ready]);assert.equal(a.ws.protocol,"gafchat");
  const key=await crypto.webcrypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
  const iv=crypto.randomBytes(12),plain="Private test message";
  const encrypted=await crypto.webcrypto.subtle.encrypt({name:"AES-GCM",iv},key,Buffer.from(plain));
  a.ws.send(JSON.stringify({type:"message",iv:iv.toString("base64url"),ciphertext:Buffer.from(encrypted).toString("base64url")}));
  const relayed=await until(()=>b.messages.find(m=>m.type==="message"));
  assert.equal(JSON.stringify(relayed).includes(plain),false);
  const decrypted=await crypto.webcrypto.subtle.decrypt({name:"AES-GCM",iv:Buffer.from(relayed.iv,"base64url")},key,Buffer.from(relayed.ciphertext,"base64url"));
  assert.equal(Buffer.from(decrypted).toString(),plain);
  for(const options of [{origin:"https://other.example"},{origin:""}]){
    const denied=connect(f,room.room,guest.token,options);await assert.rejects(denied.ready,/403/);denied.ws.terminate();
  }
  const legacy=new WebSocket(f.base.replace("http:","ws:")+`/ws?room=${room.room}&token=${room.token}`,{origin});
  await assert.rejects(new Promise((resolve,reject)=>{legacy.once("open",resolve);legacy.once("error",reject)}),/401/);
});

test("room/member caps and global attachment budget reject excess and release space on burn",async t=>{
  const f=await fixture(t,{MAX_ROOMS:"2",MAX_ROOM_MEMBERS:"2",TOTAL_ATTACHMENT_MAX_MB:"1"});
  const a=await f.owner(),b=await f.owner();await f.join(a);
  assert.equal((await f.request("/api/rooms",{body:{name:"Third"},headers:{Cookie:f.cookie}})).status,429);
  assert.equal((await f.request(`/api/rooms/${a.room}/join`,{body:{name:"Third",inviteToken:a.inviteToken}})).status,429);
  const upload=(room,bytes)=>fetch(f.base+`/api/rooms/${room.room}/attachments`,{method:"POST",headers:{Authorization:`Bearer ${room.token}`,"Content-Type":"application/octet-stream"},body:Buffer.alloc(bytes,7)});
  const first=await upload(a,800000);assert.equal(first.status,201);
  assert.equal((await upload(b,400000)).status,413);
  assert.equal((await f.request(`/api/rooms/${a.room}/burn`,{body:{token:a.token}})).status,200);
  assert.equal((await upload(b,400000)).status,201);
  assert.equal((await f.request(`/api/rooms/${a.room}/status`,{headers:{Authorization:`Bearer ${a.token}`}})).status,404);
});

test("an upload finishing after burn cannot resurrect room data",async t=>{
  const f=await fixture(t),room=await f.owner();
  let request;
  const finished=new Promise((resolve,reject)=>{
    request=http.request(f.base+`/api/rooms/${room.room}/attachments`,{method:"POST",headers:{Authorization:`Bearer ${room.token}`,"Content-Type":"application/octet-stream","Content-Length":"100"}},res=>{res.resume();res.once("end",()=>resolve(res.statusCode))});
    request.once("error",reject);request.write(Buffer.alloc(50));
  });
  await wait(50);await f.request(`/api/rooms/${room.room}/burn`,{body:{token:room.token}});request.end(Buffer.alloc(50));
  assert.equal(await finished,410);assert.equal((await f.request("/api/health")).data.rooms,0);
});

test("absolute room expiry closes an active socket and removes room access",async t=>{
  const f=await fixture(t,{ROOM_MAX_AGE_MINUTES:"0.01"}),room=await f.owner();
  const a=connect(f,room.room,room.token);await a.ready;t.after(()=>a.ws.terminate());
  const closed=new Promise(r=>a.ws.once("close",code=>r(code)));
  const timer=setInterval(()=>{if(a.ws.readyState===WebSocket.OPEN)a.ws.send(JSON.stringify({type:"typing",active:true}))},50);t.after(()=>clearInterval(timer));
  assert.equal(await Promise.race([closed,wait(2500).then(()=>"timeout")]),4004);
  assert.equal((await f.request("/api/health")).data.rooms,0);
});

test("login and WebSocket floods are throttled",async t=>{
  const f=await fixture(t),room=await f.owner();
  let status;
  for(let i=0;i<10;i++)status=(await f.request("/api/host/login",{body:{password:"wrong"}})).status;
  assert.equal(status,429);
  const a=connect(f,room.room,room.token);await a.ready;t.after(()=>a.ws.terminate());
  const closed=new Promise(r=>a.ws.once("close",code=>r(code)));
  for(let i=0;i<81;i++)a.ws.send(JSON.stringify({type:"typing",active:false}));
  assert.equal(await Promise.race([closed,wait(2000).then(()=>"timeout")]),1008);
});

test("private state writes are 0600 and only packaged assets are served",async t=>{
  const f=await fixture(t);
  assert.equal((await f.request("/api/host/push/unsubscribe",{body:{endpoint:"https://push.example.invalid/test"},headers:{Cookie:f.cookie}})).status,200);
  assert.equal((await stat(path.join(f.dir,"push.json"))).mode&0o777,0o600);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dir,"push.json"),"utf8")),[]);
  for(const file of ["/server.js","/app.next.js","/index.html.before-test","/.env"]){assert.equal((await f.request(file)).status,404)}
  const font=await f.request("/fonts/titillium-web-latin-400-normal.woff2");assert.equal(font.status,200);
  const page=await f.request("/");assert.equal(page.data.includes("fonts.googleapis.com"),false);
  assert.match(page.headers.get("content-security-policy"),/default-src 'none'/);
  assert.equal(page.headers.get("referrer-policy"),"no-referrer");
});

test("trusted-device enrollment expires, and host revocation blocks future access",async t=>{
  const f=await fixture(t);
  const invite=await f.request("/api/trust/invite",{body:{label:"Test device"},headers:{Cookie:f.cookie}});
  assert.equal(invite.status,201);
  let db=JSON.parse(await readFile(path.join(f.dir,"trusted.json"),"utf8"));
  assert.ok(db.invites[0].expiresAt-Date.now()<=86400000);
  const enrolled=await f.request("/api/trust/enroll",{body:{token:invite.data.token}});
  assert.equal(enrolled.status,200);assert.match(enrolled.headers.get("set-cookie"),/Max-Age=7776000/);
  const cookie=enrolled.headers.get("set-cookie").split(";")[0];
  assert.equal((await f.request("/api/trust/status",{headers:{Cookie:cookie}})).data.trusted,true);
  assert.equal((await f.request("/api/rooms",{body:{name:"Trusted guest"},headers:{Cookie:cookie}})).status,403);
  const room=await f.owner();
  assert.equal((await f.request(`/api/rooms/${room.room}/join`,{body:{name:"Trusted guest"},headers:{Cookie:cookie}})).status,200);
  const listed=await f.request("/api/trust/devices",{headers:{Cookie:f.cookie}});
  assert.equal(listed.data.devices.length,1);assert.equal("tokenHash" in listed.data.devices[0],false);
  assert.equal((await f.request("/api/trust/revoke",{body:{id:listed.data.devices[0].id},headers:{Cookie:cookie}})).status,403);
  assert.equal((await f.request("/api/trust/revoke",{body:{id:listed.data.devices[0].id},headers:{Cookie:f.cookie}})).status,200);
  assert.equal((await f.request("/api/trust/status",{headers:{Cookie:cookie}})).data.trusted,false);
  assert.equal((await f.request("/api/rooms",{body:{name:"Revoked"},headers:{Cookie:cookie}})).status,403);
});
