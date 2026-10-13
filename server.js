import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

import webpush from "web-push";
import * as gafPushFs from "node:fs";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 8787);
const TTL = Number(process.env.ROOM_TTL_MINUTES || 360) * 60000;
const ORIGINS = new Set((process.env.ALLOWED_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean));
const HOST_PASSWORD = String(process.env.HOST_PASSWORD || "");
const GAFBOX_URL = String(process.env.GAFBOX_URL || "").replace(/\/$/,"");
const GAFBOX_SHARED_SECRET = String(process.env.GAFBOX_SHARED_SECRET || "");
const HOST_AUTH_SECRET = String(process.env.HOST_AUTH_SECRET || "") ||
  (HOST_PASSWORD ? crypto.createHash("sha256").update(`gafchat-host:${HOST_PASSWORD}`).digest("hex") : "") ||
  (GAFBOX_SHARED_SECRET ? crypto.createHash("sha256").update(`gafchat-host:${GAFBOX_SHARED_SECRET}`).digest("hex") : "") ||
  crypto.randomBytes(32).toString("hex");
const PUBLIC_ORIGIN = String(process.env.PUBLIC_ORIGIN || "https://example.com").replace(/\/$/,"");
const HOST_COOKIE = "gafchat_host";
const HOST_MAX_AGE = 60 * 60 * 24 * 365 * 10;

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || PUBLIC_ORIGIN;
const HOST_PUSH_FILE = new URL("./host-push.json", import.meta.url);

function loadHostPushSubscriptions(){
  try{
    const parsed=JSON.parse(gafPushFs.readFileSync(HOST_PUSH_FILE,"utf8"));
    return Array.isArray(parsed)?parsed:[];
  }catch{
    return [];
  }
}

let hostPushSubscriptions=loadHostPushSubscriptions();

function saveHostPushSubscriptions(){
  const tmp=new URL("./host-push.json.tmp",import.meta.url);

  gafPushFs.writeFileSync(
    tmp,
    JSON.stringify(hostPushSubscriptions,null,2),
    {mode:0o600}
  );

  gafPushFs.renameSync(tmp,HOST_PUSH_FILE);

  try{gafPushFs.chmodSync(HOST_PUSH_FILE,0o600)}catch{}
}

if(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY){
  webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

async function sendHostPush(title,body,url="/host"){
  if(!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !hostPushSubscriptions.length){
    return false;
  }

  let sent=false;
  const dead=[];

  const payload=JSON.stringify({
    title,
    body,
    url
  });

  for(const sub of hostPushSubscriptions){
    try{
      await webpush.sendNotification(sub,payload);
      sent=true;
    }catch(err){
      if(err?.statusCode===404 || err?.statusCode===410){
        dead.push(sub.endpoint);
      }else{
        console.warn("GafChat push failed:",err?.message||err);
      }
    }
  }

  if(dead.length){
    hostPushSubscriptions=hostPushSubscriptions.filter(
      sub=>!dead.includes(sub.endpoint)
    );
    saveHostPushSubscriptions();
  }

  return sent;
}


const TRUST_COOKIE = "gafchat_trusted";
const TRUST_MAX_AGE = 60 * 60 * 24 * 365;
const TRUST_DB = String(process.env.TRUST_DB || path.join(__dirname, "trusted-devices.json"));

const ATTACHMENT_MAX_BYTES = Number(process.env.ATTACHMENT_MAX_MB || 100) * 1024 * 1024;
const ROOM_ATTACHMENT_MAX_BYTES = Number(process.env.ROOM_ATTACHMENT_MAX_MB || 100) * 1024 * 1024;

const rooms = new Map();
const buckets = new Map();
const roomRequests = [];
const hostApprovals = new Map();

function loadTrustDb(){
  try{
    const d=JSON.parse(fs.readFileSync(TRUST_DB,"utf8"));
    return {
      devices:Array.isArray(d.devices)?d.devices:[],
      invites:Array.isArray(d.invites)?d.invites:[]
    };
  }catch{
    return {devices:[],invites:[]};
  }
}

let trustDb=loadTrustDb();

function saveTrustDb(){
  const tmp=`${TRUST_DB}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(trustDb,null,2)+"\n",{mode:0o600});
  fs.renameSync(tmp,TRUST_DB);
}

function pruneTrustDb(){
  const t=Date.now();
  trustDb.invites=trustDb.invites.filter(x=>Number(x.expiresAt||0)>t);
}

const now = () => Date.now();
const rid = (n=18) => crypto.randomBytes(n).toString("base64url");
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");

function tokenMatches(expected, token) {
  try {
    const a = Buffer.from(expected, "hex");
    const b = crypto.createHash("sha256").update(String(token)).digest();
    return a.length === b.length && crypto.timingSafeEqual(a,b);
  } catch { return false; }
}

function code() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i=0;i<6;i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}

function cleanName(v) {
  return String(v || "").replace(/[^\p{L}\p{N} ._'’-]/gu,"").trim().slice(0,32);
}

function headers() {
  return {
    "X-Content-Type-Options":"nosniff",
    "Referrer-Policy":"no-referrer",
    "Permissions-Policy":"camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy":"same-origin",
    "Content-Security-Policy":[
      "default-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "connect-src 'self' ws: wss:",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'"
    ].join("; ")
  };
}

function json(res,status,obj,extra={}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status,{...headers(),"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Content-Length":body.length,...extra});
  res.end(body);
}

function send(ws,obj) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(room,obj) { for (const ws of room.clients) send(ws,obj); }

function parseCookies(req){
  const out={};
  for(const chunk of String(req.headers.cookie||"").split(";")){
    const i=chunk.indexOf("="); if(i<0) continue;
    out[chunk.slice(0,i).trim()]=decodeURIComponent(chunk.slice(i+1).trim());
  }
  return out;
}

function signHost(payload){
  const body=Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig=crypto.createHmac("sha256",HOST_AUTH_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readHostToken(token){
  try{
    const [body,sig]=String(token||"").split(".");
    if(!body||!sig)return null;
    const expected=crypto.createHmac("sha256",HOST_AUTH_SECRET).update(body).digest("base64url");
    const a=Buffer.from(sig),b=Buffer.from(expected);
    if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return null;
    const data=JSON.parse(Buffer.from(body,"base64url").toString("utf8"));
    if(data.exp<Math.floor(Date.now()/1000))return null;
    return data;
  }catch{return null}
}

function isHost(req){ return Boolean(readHostToken(parseCookies(req)[HOST_COOKIE])); }
function hostCookie(token){ return `${HOST_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${HOST_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`; }
function clearHostCookie(){ return `${HOST_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`; }

function trustedCookie(token){
  return `${TRUST_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${TRUST_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`;
}

function trustedDevice(req){
  const raw=parseCookies(req)[TRUST_COOKIE]||"";
  if(!raw)return null;
  const hash=sha(raw);
  return trustDb.devices.find(x=>x.tokenHash===hash)||null;
}

function canCreateRoom(req){
  return isHost(req)||Boolean(trustedDevice(req));
}

function onlineMembers(room){
  return [...room.online].map(id=>room.members.get(id)).filter(Boolean).map(({id,name,owner})=>({id,name,owner}));
}

function auth(roomCode, token) {
  const room = rooms.get(String(roomCode||"").toUpperCase());
  if (!room) return null;
  for (const member of room.members.values()) if (tokenMatches(member.tokenHash, token)) return {room,member};
  return null;
}

function rate(ip) {
  if(process.env.DISABLE_RATE_LIMIT==="1") return true;
  const t = now(); let b = buckets.get(ip);
  if (!b || t-b.start > 60000) b = {start:t,count:0};
  b.count++; buckets.set(ip,b); return b.count <= 100;
}

async function readJson(req,max=16384) {
  return new Promise((resolve,reject)=>{
    let size=0,chunks=[],done=false;
    req.on("data",c=>{if(done)return;size+=c.length;if(size>max){done=true;reject(Object.assign(new Error("Request too large"),{status:413}));req.resume();return;}chunks.push(c)});
    req.on("end",()=>{if(done)return;try{resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}"))}catch{reject(Object.assign(new Error("Bad JSON"),{status:400}))}});
    req.on("error",reject);
  });
}

async function readBuffer(req,max) {
  return new Promise((resolve,reject)=>{
    let size=0,chunks=[],done=false;
    req.on("data",c=>{if(done)return;size+=c.length;if(size>max){done=true;reject(Object.assign(new Error("File too large"),{status:413}));req.resume();return;}chunks.push(c)});
    req.on("end",()=>{if(done)return;resolve(Buffer.concat(chunks))});
    req.on("error",reject);
  });
}

function mime(file){return {
  ".html":"text/html; charset=utf-8",
  ".css":"text/css; charset=utf-8",
  ".js":"text/javascript; charset=utf-8",
  ".png":"image/png",
  ".jpg":"image/jpeg",
  ".jpeg":"image/jpeg",
  ".gif":"image/gif",
  ".webp":"image/webp",
  ".svg":"image/svg+xml",
  ".ico":"image/x-icon",
  ".json":"application/json; charset=utf-8"
}[path.extname(file).toLowerCase()]||"application/octet-stream"}

function addNotice(room,text,kind="notice"){
  const n={id:rid(8),text,kind,at:now()}; room.notices.set(n.id,n);
  for(const ws of room.clients) if(ws.memberId===room.ownerId) send(ws,{type:"notice",notice:n});
}

function wipeRoom(room) {
  room.history.length = 0;
  room.attachments?.clear();
  room.attachmentBytes = 0;
  room.notices.clear();
  room.pending.clear();
  room.approvals.clear();
}

function destroyRoom(room) {
  broadcast(room,{type:"burned"});
  for (const ws of room.clients) { try { ws.close(4004,"Room burned"); } catch {} }
  wipeRoom(room);
  rooms.delete(room.code);
}

async function postGafBox(pathname,payload){
  if(!GAFBOX_URL || !GAFBOX_SHARED_SECRET) return {delivered:false,reason:"not_configured"};
  try{
    const r=await fetch(`${GAFBOX_URL}${pathname}`,{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${GAFBOX_SHARED_SECRET}`},
      body:JSON.stringify(payload)
    });
    return {delivered:r.ok,status:r.status,data:await r.json().catch(()=>({}))};
  }catch(e){return {delivered:false,reason:"failed"}}
}

function hostDeviceLabel(req){
  const ua=String(req.headers["user-agent"]||"");
  if(/iphone/i.test(ua)) return "iPhone";
  if(/ipad/i.test(ua)) return "iPad";
  if(/macintosh|mac os/i.test(ua)) return "Mac";
  if(/windows/i.test(ua)) return "Windows PC";
  if(/android/i.test(ua)) return "Android device";
  return "New browser";
}


const server = http.createServer(async (req,res)=>{
  const ip = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown";
  if (!rate(ip)) return json(res,429,{ok:false,error:"Too many requests."});

  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if(req.method==="GET" && url.pathname==="/api/health") return json(res,200,{ok:true,version:"0.5.2",rooms:rooms.size});

    if(req.method==="GET" && url.pathname==="/api/host/status"){
      const host=isHost(req);

      const data={
        ok:true,
        host,
        passwordConfigured:Boolean(HOST_PASSWORD),
        approvalConfigured:Boolean(GAFBOX_URL&&GAFBOX_SHARED_SECRET),
        pushConfigured:Boolean(VAPID_PUBLIC_KEY&&VAPID_PRIVATE_KEY),
        requests:host
          ?roomRequests
            .filter(x=>x.status==="pending"&&x.expiresAt>now())
            .slice(-10)
            .reverse()
            .map(({id,name,at,userAgent,guestPub})=>({id,name,at,userAgent,guestPub}))
          :[]
      };

      if(host){
        const t=signHost({
          device:rid(10),
          iat:Math.floor(Date.now()/1000),
          exp:Math.floor(Date.now()/1000)+HOST_MAX_AGE
        });

        return json(res,200,data,{"Set-Cookie":hostCookie(t)});
      }

      return json(res,200,data);
    }

    if(req.method==="GET" && url.pathname==="/api/push/public-key"){
      return json(res,200,{
        ok:true,
        publicKey:VAPID_PUBLIC_KEY
      });
    }

    if(req.method==="POST" && url.pathname==="/api/host/push/subscribe"){
      if(!isHost(req))
        return json(res,403,{ok:false,error:"Host only."});

      if(!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY)
        return json(res,503,{ok:false,error:"Push is not configured."});

      const body=await readJson(req);
      const sub=body.subscription;

      if(
        !sub ||
        typeof sub.endpoint!=="string" ||
        !sub.endpoint.startsWith("https://") ||
        !sub.keys?.p256dh ||
        !sub.keys?.auth
      ){
        return json(res,400,{ok:false,error:"Invalid push subscription."});
      }

      hostPushSubscriptions=hostPushSubscriptions.filter(
        x=>x.endpoint!==sub.endpoint
      );

      hostPushSubscriptions.push(sub);
      saveHostPushSubscriptions();

      return json(res,200,{ok:true,subscribed:true});
    }

    if(req.method==="POST" && url.pathname==="/api/host/push/unsubscribe"){
      if(!isHost(req))
        return json(res,403,{ok:false,error:"Host only."});

      const body=await readJson(req);
      const endpoint=String(body.endpoint||"");

      hostPushSubscriptions=hostPushSubscriptions.filter(
        x=>x.endpoint!==endpoint
      );

      saveHostPushSubscriptions();
      return json(res,200,{ok:true});
    }

    if(req.method==="POST" && url.pathname==="/api/host/approval/start"){
      if(!GAFBOX_URL || !GAFBOX_SHARED_SECRET) return json(res,503,{ok:false,error:"GafBox approval is not configured yet."});
      const id=rid(12),claim=rid(),callbackToken=rid();
      const entry={id,claimHash:sha(claim),callbackHash:sha(callbackToken),status:"pending",createdAt:now(),expiresAt:now()+10*60000,device:hostDeviceLabel(req)};
      hostApprovals.set(id,entry);
      const base=PUBLIC_ORIGIN;
      const approveUrl=`${base}/api/host/approval/decision?id=${encodeURIComponent(id)}&token=${encodeURIComponent(callbackToken)}&decision=approve`;
      const denyUrl=`${base}/api/host/approval/decision?id=${encodeURIComponent(id)}&token=${encodeURIComponent(callbackToken)}&decision=deny`;
      const pushed=await postGafBox("/api/gafchat/host-approval",{requestId:id,device:entry.device,approveUrl,denyUrl});
      if(!pushed.delivered){hostApprovals.delete(id);return json(res,502,{ok:false,error:"Could not reach GafBox."});}
      return json(res,202,{ok:true,id,claim,expiresAt:entry.expiresAt});
    }

    if(req.method==="GET" && url.pathname==="/api/host/approval/decision"){
      const id=url.searchParams.get("id")||"",token=url.searchParams.get("token")||"",decision=url.searchParams.get("decision")==="approve"?"approved":"denied";
      const a=hostApprovals.get(id);
      if(!a || a.expiresAt<now()) return json(res,410,{ok:false,error:"Approval expired."});
      if(!tokenMatches(a.callbackHash,token)) return json(res,403,{ok:false,error:"Invalid approval."});
      a.status=decision; a.decidedAt=now();
      return json(res,200,{ok:true,status:decision});
    }

    if(req.method==="GET" && url.pathname==="/api/host/approval/status"){
      const id=url.searchParams.get("id")||"",claim=url.searchParams.get("claim")||"";
      const a=hostApprovals.get(id);
      if(!a || a.expiresAt<now()){hostApprovals.delete(id);return json(res,410,{ok:false,error:"Approval expired."});}
      if(!tokenMatches(a.claimHash,claim)) return json(res,403,{ok:false,error:"Invalid approval request."});
      if(a.status==="pending") return json(res,200,{ok:true,status:"pending"});
      if(a.status==="denied"){hostApprovals.delete(id);return json(res,200,{ok:true,status:"denied"});}
      const t=signHost({device:rid(10),iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+HOST_MAX_AGE});
      hostApprovals.delete(id);
      return json(res,200,{ok:true,status:"approved",host:true},{"Set-Cookie":hostCookie(t)});
    }

    if(req.method==="POST" && url.pathname==="/api/host/login"){
      if(!HOST_PASSWORD) return json(res,503,{ok:false,error:"Host login is not configured on the server yet."});
      const body=await readJson(req);
      const a=Buffer.from(sha(body.password||""),"hex"), b=Buffer.from(sha(HOST_PASSWORD),"hex");
      if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return json(res,403,{ok:false,error:"Nope."});
      const t=signHost({device:rid(10),iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+HOST_MAX_AGE});
      return json(res,200,{ok:true,host:true},{"Set-Cookie":hostCookie(t)});
    }

    if(req.method==="POST" && url.pathname==="/api/host/logout") return json(res,200,{ok:true},{"Set-Cookie":clearHostCookie()});

    if(req.method==="POST" && url.pathname==="/api/trust/invite"){
      if(!isHost(req)) return json(res,403,{ok:false,error:"Host only."});

      const body=await readJson(req);
      const label=String(body.label||"Trusted person").trim().slice(0,80)||"Trusted person";
      const token=rid(32);

      pruneTrustDb();
      trustDb.invites.push({
        tokenHash:sha(token),
        label,
        createdAt:now(),
        expiresAt:now()+7*24*60*60*1000
      });
      saveTrustDb();

      return json(res,201,{ok:true,token,label});
    }

    if(req.method==="POST" && url.pathname==="/api/trust/enroll"){
      const body=await readJson(req);
      const token=String(body.token||"");

      pruneTrustDb();
      const hash=sha(token);
      const i=trustDb.invites.findIndex(x=>x.tokenHash===hash);

      if(i<0) return json(res,410,{ok:false,error:"Trust invite is invalid or expired."});

      const invite=trustDb.invites[i];
      trustDb.invites.splice(i,1);

      const deviceToken=rid(32);
      trustDb.devices.push({
        id:rid(10),
        tokenHash:sha(deviceToken),
        label:invite.label,
        createdAt:now(),
        lastSeenAt:now()
      });

      saveTrustDb();

      return json(
        res,
        200,
        {ok:true,trusted:true,label:invite.label},
        {"Set-Cookie":trustedCookie(deviceToken)}
      );
    }

    if(req.method==="GET" && url.pathname==="/api/trust/status"){
      const d=trustedDevice(req);
      return json(res,200,{ok:true,trusted:Boolean(d),label:d?.label||""});
    }

    if(req.method==="POST" && url.pathname==="/api/room-request"){
      const body=await readJson(req);
      const name=cleanName(body.name);
      const guestPub=body.guestPub;

      if(!name) return json(res,400,{ok:false,error:"Enter your name."});
      if(!guestPub || guestPub.kty!=="EC" || guestPub.crv!=="P-256" || !guestPub.x || !guestPub.y)
        return json(res,400,{ok:false,error:"Could not create secure request."});

      const claim=rid(32);
      const request={
        id:rid(10),
        name,
        at:now(),
        expiresAt:now()+15*60*1000,
        userAgent:String(req.headers["user-agent"]||"").slice(0,180),
        guestPub,
        claimHash:sha(claim),
        status:"pending"
      };

      roomRequests.push(request);
      if(roomRequests.length>50) roomRequests.shift();

      const directPush=await sendHostPush(
        "GafChat",
        `${name} wants to chat`,
        "/host"
      );

      return json(res,202,{
        ok:true,
        delivered:directPush,
        id:request.id,
        claim,
        expiresAt:request.expiresAt
      });
    }

    let inbound = url.pathname.match(/^\/api\/room-request\/([^/]+)$/);

    if(req.method==="GET" && inbound){
      const r=roomRequests.find(x=>x.id===inbound[1]);
      if(!r || r.expiresAt<now())
        return json(res,410,{ok:false,error:"Request expired."});

      const claim=url.searchParams.get("claim")||"";
      if(!tokenMatches(r.claimHash,claim))
        return json(res,403,{ok:false,error:"Invalid request."});

      if(r.status==="pending")
        return json(res,200,{ok:true,status:"pending"});

      if(r.status==="denied")
        return json(res,200,{ok:true,status:"denied"});

      if(r.status==="approved"){
        const result=r.guestResult;
        r.status="consumed";
        return json(res,200,{ok:true,status:"approved",...result});
      }

      return json(res,410,{ok:false,error:"Request closed."});
    }

    inbound = url.pathname.match(/^\/api\/room-request\/([^/]+)\/decision$/);

    if(req.method==="POST" && inbound){
      if(!isHost(req))
        return json(res,403,{ok:false,error:"Host only."});

      const r=roomRequests.find(x=>x.id===inbound[1] && x.status==="pending");
      if(!r)
        return json(res,404,{ok:false,error:"Request not found."});

      const body=await readJson(req);

      if(body.approve===false){
        r.status="denied";
        return json(res,200,{ok:true,status:"denied"});
      }

      const hostPub=body.hostPub;
      if(!hostPub || hostPub.kty!=="EC" || hostPub.crv!=="P-256" || !hostPub.x || !hostPub.y)
        return json(res,400,{ok:false,error:"Secure host key missing."});

      let roomCode;
      do roomCode=code(); while(rooms.has(roomCode));

      const ownerToken=rid();
      const ownerId=rid(10);
      const guestToken=rid();
      const guestId=rid(10);
      const inviteToken=rid(32);

      const ownerMember={id:ownerId,name:"Gaf",owner:true};
      const guestMember={id:guestId,name:r.name,owner:false};

      const room={
        code:roomCode,
        inviteHash:sha(inviteToken),
        createdAt:now(),
        touchedAt:now(),
        ownerId,
        members:new Map(),
        pending:new Map(),
        approvals:new Map(),
        clients:new Set(),
        online:new Set(),
        disconnectTimers:new Map(),
        history:[],
        notices:new Map(),
        attachments:new Map(),
        attachmentBytes:0
      };

      room.members.set(ownerId,{...ownerMember,tokenHash:sha(ownerToken)});
      room.members.set(guestId,{...guestMember,tokenHash:sha(guestToken)});
      rooms.set(roomCode,room);

      let trustToken="";

      if(body.save===true){
        pruneTrustDb();
        trustToken=rid(32);

        trustDb.invites.push({
          tokenHash:sha(trustToken),
          label:r.name,
          createdAt:now(),
          expiresAt:now()+10*60*1000
        });

        saveTrustDb();
      }

      r.status="approved";

      r.guestResult={
        room:roomCode,
        createdAt:room.createdAt,
        token:guestToken,
        member:guestMember,
        hostPub,
        ...(trustToken?{trustToken}:{})
      };

      return json(res,200,{
        ok:true,
        status:"approved",
        room:roomCode,
        createdAt:room.createdAt,
        token:ownerToken,
        member:ownerMember,
        inviteToken,
        guestPub:r.guestPub,
        saved:Boolean(trustToken)
      });
    }

    if(req.method==="POST" && url.pathname==="/api/rooms"){
      if(!canCreateRoom(req)) return json(res,403,{ok:false,error:"Trusted device only."});
      const body = await readJson(req); const name = cleanName(body.name)||"Gaf";
      let roomCode; do roomCode = code(); while(rooms.has(roomCode));
      const ownerToken = rid(), ownerId = rid(10), inviteToken = rid(32);
      const room = {code:roomCode,inviteHash:sha(inviteToken),createdAt:now(),touchedAt:now(),ownerId,members:new Map(),pending:new Map(),approvals:new Map(),clients:new Set(),online:new Set(),disconnectTimers:new Map(),history:[],notices:new Map(),attachments:new Map(),attachmentBytes:0};
      room.members.set(ownerId,{id:ownerId,name,owner:true,tokenHash:sha(ownerToken)}); rooms.set(roomCode,room);
      return json(res,201,{ok:true,room:roomCode,inviteToken,createdAt:room.createdAt,token:ownerToken,member:{id:ownerId,name,owner:true}});
    }

    let m = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/status$/i);
    if(req.method==="GET" && m){
      const token=url.searchParams.get("token")||"";
      const a=auth(m[1],token);
      if(!a)return json(res,404,{ok:false,error:"Room gone."});
      return json(res,200,{ok:true,room:a.room.code});
    }

    m = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/join$/i);
    if(req.method==="POST" && m){
      const room = rooms.get(m[1].toUpperCase()); if(!room) return json(res,404,{ok:false,error:"Room not found."});
      const body = await readJson(req), name = cleanName(body.name);
      if(!name) return json(res,400,{ok:false,error:"Enter your name."});

      const trusted=trustedDevice(req);
      const invited=Boolean(body.inviteToken && tokenMatches(room.inviteHash,body.inviteToken));

      if(trusted || invited){
        const token=rid(),member={id:rid(10),name,owner:false};
        room.members.set(member.id,{...member,tokenHash:sha(token)});
        room.touchedAt=now();
        broadcast(room,{type:"member_joined",member});
        return json(res,200,{ok:true,status:"approved",token,member,trusted:Boolean(trusted),invited});
      }

      const requestId=rid(12), claim=rid();
      room.pending.set(requestId,{id:requestId,name,claimHash:sha(claim)});
      room.touchedAt=now();

      for(const ws of room.clients)
        if(ws.memberId===room.ownerId)
          send(ws,{type:"join_request",request:{id:requestId,name}});

      return json(res,202,{ok:true,status:"pending",requestId,claimToken:claim});
    }

    m = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/requests\/([^/]+)$/i);
    if(req.method==="GET" && m){
      const room=rooms.get(m[1].toUpperCase()); if(!room)return json(res,404,{ok:false,error:"Room not found."});
      const requestId=m[2],claim=url.searchParams.get("claim")||"",pending=room.pending.get(requestId);
      if(pending){if(!tokenMatches(pending.claimHash,claim))return json(res,403,{ok:false,error:"Invalid request."});return json(res,200,{ok:true,status:"pending"})}
      const approval=room.approvals.get(requestId);
      if(approval){if(!tokenMatches(approval.claimHash,claim))return json(res,403,{ok:false,error:"Invalid request."});room.approvals.delete(requestId);return json(res,200,{ok:true,...approval})}
      return json(res,410,{ok:false,error:"Request expired."});
    }

    m = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/approve$/i);
    if(req.method==="POST" && m){
      const body=await readJson(req),a=auth(m[1],body.token); if(!a?.member.owner)return json(res,403,{ok:false,error:"Owner only."});
      const p=a.room.pending.get(body.requestId); if(!p)return json(res,404,{ok:false,error:"Request not found."}); a.room.pending.delete(p.id);
      if(body.approve===false){a.room.approvals.set(p.id,{status:"denied",claimHash:p.claimHash});return json(res,200,{ok:true,status:"denied"})}

      let trustToken="";
      if(body.save===true){
        pruneTrustDb();
        trustToken=rid(32);
        trustDb.invites.push({
          tokenHash:sha(trustToken),
          label:p.name,
          createdAt:now(),
          expiresAt:now()+10*60*1000
        });
        saveTrustDb();
      }

      const token=rid(),member={id:rid(10),name:p.name,owner:false};
      a.room.members.set(member.id,{...member,tokenHash:sha(token)});
      a.room.approvals.set(p.id,{
        status:"approved",
        claimHash:p.claimHash,
        token,
        member,
        ...(trustToken?{trustToken}:{})
      });

      broadcast(a.room,{type:"member_joined",member});
      return json(res,200,{ok:true,status:"approved",saved:Boolean(trustToken)});
    }

    m = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/boot$/i);
    if(req.method==="POST" && m){
      const body=await readJson(req),a=auth(m[1],body.token); if(!a?.member.owner)return json(res,403,{ok:false,error:"Owner only."});
      const target=a.room.members.get(String(body.memberId||"")); if(!target||target.owner)return json(res,404,{ok:false,error:"Member not found."});
      a.room.members.delete(target.id); a.room.online.delete(target.id);
      for(const ws of a.room.clients) if(ws.memberId===target.id){send(ws,{type:"booted"});try{ws.close(4003,"Booted")}catch{}}
      addNotice(a.room,`${target.name} was booted`,"left"); broadcast(a.room,{type:"presence",members:onlineMembers(a.room)}); return json(res,200,{ok:true});
    }

    m = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/notices\/([^/]+)$/i);
    if(req.method==="DELETE" && m){
      const token=url.searchParams.get("token")||"",a=auth(m[1],token); if(!a?.member.owner)return json(res,403,{ok:false,error:"Owner only."});
      a.room.notices.delete(m[2]); return json(res,200,{ok:true});
    }

    m = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/attachments$/i);
    if(req.method==="POST" && m){
      const token=String(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
      const a=auth(m[1],token); if(!a)return json(res,403,{ok:false,error:"Room access required."});
      if((a.room.attachmentBytes||0)>=ROOM_ATTACHMENT_MAX_BYTES)return json(res,413,{ok:false,error:"Room file cache is full."});
      const max=Math.min(ATTACHMENT_MAX_BYTES,ROOM_ATTACHMENT_MAX_BYTES-(a.room.attachmentBytes||0));
      const blob=await readBuffer(req,max); if(!blob.length)return json(res,400,{ok:false,error:"Empty file."});
      const id=rid(12); a.room.attachments.set(id,{id,memberId:a.member.id,blob,bytes:blob.length,createdAt:now()});
      a.room.attachmentBytes=(a.room.attachmentBytes||0)+blob.length; a.room.touchedAt=now();
      return json(res,201,{ok:true,id,bytes:blob.length});
    }

    m = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/attachments\/([^/]+)$/i);
    if(req.method==="GET" && m){
      const token=String(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
      const a=auth(m[1],token); if(!a)return json(res,403,{ok:false,error:"Room access required."});
      const item=a.room.attachments.get(m[2]); if(!item)return json(res,404,{ok:false,error:"File not found."});
      res.writeHead(200,{...headers(),"Content-Type":"application/octet-stream","Cache-Control":"no-store","Content-Length":item.blob.length});
      res.end(item.blob); return;
    }

    m = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/burn$/i);
    if(req.method==="POST" && m){
      const body=await readJson(req),a=auth(m[1],body.token); if(!a?.member.owner)return json(res,403,{ok:false,error:"Owner only."});
      json(res,200,{ok:true}); destroyRoom(a.room); return;
    }

    if(req.method==="GET"){
      const inviteRoute=/^\/r\/[A-Z0-9]{6}$/i.test(url.pathname);
      let file = (url.pathname==="/"||url.pathname==="/host"||inviteRoute)
        ? path.join(PUBLIC,"index.html")
        : path.normalize(path.join(PUBLIC,decodeURIComponent(url.pathname)));
      if(!file.startsWith(PUBLIC)) return json(res,400,{ok:false,error:"Bad path."});
      fs.stat(file,(err,st)=>{if(err||!st.isFile()){res.writeHead(404,headers());res.end("Not found");return}res.writeHead(200,{...headers(),"Content-Type":mime(file),"Cache-Control":"no-store"});fs.createReadStream(file).pipe(res)}); return;
    }

    json(res,404,{ok:false,error:"Not found."});
  } catch(err){console.error(err);if(!res.headersSent)json(res,err.status||500,{ok:false,error:err.status?err.message:"Server error."})}
});

const wss = new WebSocketServer({noServer:true,maxPayload:65536,perMessageDeflate:false});
server.on("upgrade",(req,socket,head)=>{
  try{
    const origin=req.headers.origin||""; if(ORIGINS.size&&!ORIGINS.has(origin)){socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");socket.destroy();return}
    const url=new URL(req.url,`http://${req.headers.host||"localhost"}`); if(url.pathname!=="/ws"){socket.destroy();return}
    const a=auth(url.searchParams.get("room"),url.searchParams.get("token")); if(!a){socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");socket.destroy();return}
    wss.handleUpgrade(req,socket,head,ws=>{ws.roomCode=a.room.code;ws.memberId=a.member.id;wss.emit("connection",ws)});
  }catch{socket.destroy()}
});

wss.on("connection",ws=>{
  const room=rooms.get(ws.roomCode); if(!room)return ws.close(1008,"Expired");
  room.clients.add(ws); room.touchedAt=now();
  const wasOnline=room.online.has(ws.memberId); room.online.add(ws.memberId);
  const timer=room.disconnectTimers.get(ws.memberId); if(timer){clearTimeout(timer);room.disconnectTimers.delete(ws.memberId)}

  send(ws,{type:"ready",room:room.code,createdAt:room.createdAt,members:onlineMembers(room),pending:ws.memberId===room.ownerId?[...room.pending.values()].map(({id,name})=>({id,name})):[],notices:ws.memberId===room.ownerId?[...room.notices.values()]:[],history:room.history});
  broadcast(room,{type:"presence",members:onlineMembers(room)});
  if(!wasOnline){const m=room.members.get(ws.memberId);if(m&&!m.owner) addNotice(room,`${m.name} joined`,"joined")}

  ws.on("message",raw=>{
    let msg;try{msg=JSON.parse(raw.toString("utf8"))}catch{return}
    if(msg.type==="leave"){ws.intentionalLeave=true;try{ws.close(1000,"Left")}catch{};return}
    const member=room.members.get(ws.memberId); if(!member)return;
    if(msg.type==="typing"){
      broadcast(room,{
        type:"typing",
        sender:{id:member.id,name:member.name},
        active:Boolean(msg.active)
      });
      return;
    }

    if(msg.type==="reaction"){
      const targetId=String(msg.targetId||"");
      const ciphertext=String(msg.ciphertext||"");
      const iv=String(msg.iv||"");

      if(!targetId||!ciphertext||!iv||ciphertext.length>2000||iv.length>64)return;

      const exists=room.history.some(x=>(x.type==="message"||x.type==="attachment") && x.id===targetId);
      if(!exists)return;

      const envelope={
        type:"reaction",
        id:rid(10),
        targetId,
        sender:{id:member.id,name:member.name},
        sentAt:now(),
        ciphertext,
        iv
      };

      room.history.push(envelope);
      if(room.history.length>250)room.history.shift();

      broadcast(room,envelope);
      room.touchedAt=now();
      return;
    }

    if(msg.type==="message"){
      const ciphertext=String(msg.ciphertext||""),iv=String(msg.iv||""); if(!ciphertext||!iv||ciphertext.length>50000||iv.length>64)return;
      const envelope={type:"message",id:rid(10),sender:{id:member.id,name:member.name},sentAt:now(),ciphertext,iv}; room.history.push(envelope); if(room.history.length>250)room.history.shift(); broadcast(room,envelope); room.touchedAt=now(); return;
    }
    if(msg.type==="attachment"){
      const att=msg.attachment||{},id=String(att.id||""),iv=String(att.iv||""),metaIv=String(att.metaIv||""),metaCiphertext=String(att.metaCiphertext||"");
      const cached=room.attachments.get(id); if(!cached||cached.memberId!==member.id||!iv||!metaIv||!metaCiphertext||iv.length>64||metaIv.length>64||metaCiphertext.length>12000)return;
      const envelope={type:"attachment",id:rid(10),sender:{id:member.id,name:member.name},sentAt:now(),attachment:{id,iv,metaIv,metaCiphertext,bytes:cached.bytes}};
      room.history.push(envelope); if(room.history.length>250)room.history.shift(); broadcast(room,envelope); room.touchedAt=now(); return;
    }
  });

  const gone=()=>{
    room.clients.delete(ws);
    if([...room.clients].some(c=>c.memberId===ws.memberId))return;
    const old=room.disconnectTimers.get(ws.memberId); if(old)clearTimeout(old);
    const t=setTimeout(()=>{
      if([...room.clients].some(c=>c.memberId===ws.memberId))return;
      room.online.delete(ws.memberId); room.disconnectTimers.delete(ws.memberId);
      const m=room.members.get(ws.memberId); if(m&&!m.owner)addNotice(room,`${m.name} left`,"left");
      broadcast(room,{type:"presence",members:onlineMembers(room)}); room.touchedAt=now();
    },ws.intentionalLeave?50:2200);
    room.disconnectTimers.set(ws.memberId,t);
  };
  ws.on("close",gone); ws.on("error",gone);
});

setInterval(()=>{const cutoff=now()-TTL;for(const [c,r] of rooms)if(r.clients.size===0&&r.touchedAt<cutoff){wipeRoom(r);rooms.delete(c)}for(const [id,a] of hostApprovals)if(a.expiresAt<now())hostApprovals.delete(id)},60000).unref();
server.listen(PORT,()=>console.log(`GafChat v0.5.2 listening on http://localhost:${PORT}`));
