const $=s=>document.querySelector(s);
const el={landing:$("#landing"),chat:$("#chat"),hostCard:$("#hostCard"),guestCard:$("#guestCard"),hostGate:$("#hostGate"),hostRequestsWrap:$("#hostRequestsWrap"),hostRequestsList:$("#hostRequestsList"),hostName:$("#hostName"),guestName:$("#guestName"),joinCode:null,startRoom:$("#startRoom"),enablePush:$("#enablePush"),joinRoom:null,requestRoom:$("#requestRoom"),confirmOnGafBox:$("#confirmOnGafBox"),approvalState:$("#approvalState"),recoveryToggle:$("#recoveryToggle"),recoveryWrap:$("#recoveryWrap"),hostPassword:$("#hostPassword"),confirmHost:$("#confirmHost"),landingError:$("#landingError"),roomLabel:$("#roomLabel"),inviteBtn:$("#inviteBtn"),peopleBtn:$("#peopleBtn"),peopleBadge:$("#peopleBadge"),leaveBtn:$("#leaveBtn"),burnBtn:$("#burnBtn"),alertBar:$("#alertBar"),alertText:$("#alertText"),reviewBtn:$("#reviewBtn"),peoplePanel:$("#peoplePanel"),closePeople:$("#closePeople"),pendingWrap:$("#pendingWrap"),pendingList:$("#pendingList"),noticeWrap:$("#noticeWrap"),noticeList:$("#noticeList"),memberList:$("#memberList"),messages:$("#messages"),composer:$("#composer"),messageInput:$("#messageInput"),toast:$("#toast"),burnModal:$("#burnModal"),cancelBurn:$("#cancelBurn"),confirmBurn:$("#confirmBurn"),attachBtn:$("#attachBtn"),fileInput:$("#fileInput")};
const state={generation:0,room:"",token:"",member:null,keyString:"",key:null,ws:null,members:[],pending:[],notices:[],createdAt:null,waitAbort:null,suppressReconnect:false,host:false,trusted:false,approvalConfigured:false,hostApprovalAbort:null,objectUrls:[],inviteRoom:"",inviteToken:"",typing:new Map(),typingTimer:null,reactions:new Map()};
function show(which){[el.landing,el.chat].forEach(x=>x.classList.add("hidden"));el[which].classList.remove("hidden")}
function err(t=""){el.landingError.textContent=t}
function toast(t){el.toast.textContent=t;el.toast.classList.remove("hidden");clearTimeout(toast._t);toast._t=setTimeout(()=>el.toast.classList.add("hidden"),1800)}
async function api(path,options={}){const res=await fetch(path,{cache:"no-store",headers:{"Content-Type":"application/json",...(options.headers||{})},...options});const data=await res.json().catch(()=>({error:"Bad server response."}));if(!res.ok)throw new Error(data.error||`Request failed (${res.status})`);return data}
const normalize=v=>String(v||"").toUpperCase().replace(/[^A-Z2-9]/g,"").slice(0,6);
function rand(n){const a=new Uint8Array(n);crypto.getRandomValues(a);return a}function b64u(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"")}function fromB64u(v){const s=v.replace(/-/g,"+").replace(/_/g,"/"),p=s+"=".repeat((4-s.length%4)%4);return Uint8Array.from(atob(p),c=>c.charCodeAt(0))}async function importKey(k){return crypto.subtle.importKey("raw",fromB64u(k),{name:"AES-GCM"},false,["encrypt","decrypt"])}


async function makeChatKeyPair(){
  const pair=await crypto.subtle.generateKey(
    {name:"ECDH",namedCurve:"P-256"},
    true,
    ["deriveBits"]
  );

  return {
    publicJwk:await crypto.subtle.exportKey("jwk",pair.publicKey),
    privateJwk:await crypto.subtle.exportKey("jwk",pair.privateKey)
  };
}

async function deriveChatKey(privateJwk,publicJwk){
  const privateKey=await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    {name:"ECDH",namedCurve:"P-256"},
    false,
    ["deriveBits"]
  );

  const publicKey=await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    {name:"ECDH",namedCurve:"P-256"},
    false,
    []
  );

  const bits=await crypto.subtle.deriveBits(
    {name:"ECDH",public:publicKey},
    privateKey,
    256
  );

  const digest=await crypto.subtle.digest("SHA-256",bits);
  return b64u(new Uint8Array(digest));
}
async function encrypt(text){const iv=rand(12);const out=await crypto.subtle.encrypt({name:"AES-GCM",iv},state.key,new TextEncoder().encode(text));return{iv:b64u(iv),ciphertext:b64u(new Uint8Array(out))}}async function decrypt(ciphertext,iv){const out=await crypto.subtle.decrypt({name:"AES-GCM",iv:fromB64u(iv)},state.key,fromB64u(ciphertext));return new TextDecoder().decode(out)}
async function encryptBytes(buffer){const iv=rand(12);const out=await crypto.subtle.encrypt({name:"AES-GCM",iv},state.key,buffer);return{iv:b64u(iv),ciphertext:out}}
async function decryptBytes(buffer,iv){return crypto.subtle.decrypt({name:"AES-GCM",iv:fromB64u(iv)},state.key,buffer)}
function clearObjectUrls(){for(const u of state.objectUrls)URL.revokeObjectURL(u);state.objectUrls=[]}
function save(){sessionStorage.setItem("gafchat_session",JSON.stringify({room:state.room,token:state.token,member:state.member,keyString:state.keyString,createdAt:state.createdAt,inviteToken:state.inviteToken||""}))}
function clearChatStorage(){
  for(let i=sessionStorage.length-1;i>=0;i--){const k=sessionStorage.key(i);if(k?.startsWith("gafchat_"))sessionStorage.removeItem(k)}
}
function reset(){
  state.generation++;state.suppressReconnect=true;
  state.waitAbort?.abort();clearTimeout(state.typingTimer);
  if(state.ws?.readyState===WebSocket.OPEN){try{state.ws.send(JSON.stringify({type:"leave"}))}catch{}}
  state.ws?.close(1000);clearChatStorage();clearObjectUrls();
  for(const media of el.messages.querySelectorAll("video,audio")){media.pause();media.removeAttribute("src");media.load()}
  el.messageInput.value="";el.fileInput.value="";state.typing.clear();state.reactions.clear();
  Object.assign(state,{room:"",token:"",member:null,keyString:"",key:null,ws:null,members:[],pending:[],notices:[],createdAt:null,inviteRoom:"",inviteToken:"",waitAbort:null});
  el.messages.replaceChildren();el.memberList.replaceChildren();el.pendingList.replaceChildren();el.noticeList.replaceChildren();
  el.peoplePanel.classList.add("hidden");el.burnModal.classList.add("hidden");clearUnread();
  const route=state.host?"/host":"/";history.replaceState(null,"",route);
  if(!state.host){location.replace("/leave");return;}
  show("landing");refreshHost();
}

async function readInvite(){
  const q=new URLSearchParams(location.search),hash=new URLSearchParams(location.hash.slice(1));
  const room=normalize((location.pathname.match(/^\/r\/([A-Z0-9]{6})$/i)||[])[1]||q.get("room"));
  let invite=null;
  const key=hash.get("key")||"",token=hash.get("invite")||"";
  if(room&&key&&token){
    invite={room,key,token,at:Date.now()};
    sessionStorage.setItem("gafchat_pending_invite",JSON.stringify(invite));
  }else{
    try{const saved=JSON.parse(sessionStorage.getItem("gafchat_pending_invite")||"null");if(saved?.room===room&&Date.now()-saved.at<900000)invite=saved}catch{}
  }
  if(location.hash)history.replaceState(null,"",location.pathname+location.search);
  if(!invite){
    if(room){
      const saved=JSON.parse(sessionStorage.getItem("gafchat_session")||"null");
      if(saved?.room===room&&saved.token)return false;
      err("This invite is incomplete. Ask for a fresh invite link.");return true;
    }
    return false;
  }
  try{
    if(!/^[A-Z2-9]{6}$/.test(invite.room)||fromB64u(invite.key).length!==32||!/^[A-Za-z0-9_-]{40,64}$/.test(invite.token))throw new Error("Invalid invite");
    state.inviteRoom=invite.room;state.inviteToken=invite.token;
    sessionStorage.setItem(`gafchat_key_${invite.room}`,invite.key);
    el.guestName.value="Guest";
    $("#inviteHint").textContent="Joining your private room…";
    await joinInvitedRoom();
  }catch{sessionStorage.removeItem("gafchat_pending_invite");err("This invite is invalid. Ask for a fresh invite link.")}
  return true;
}

async function restore(){let s;try{s=JSON.parse(sessionStorage.getItem("gafchat_session")||"null")}catch{return}if(!s?.room||!s?.token||!s?.member||!s?.keyString)return;if(!Number.isFinite(s.createdAt)||Date.now()-s.createdAt>=6*3600000){clearChatStorage();return;}Object.assign(state,s);state.key=await importKey(s.keyString);openChat()}


function vapidBytes(value){
  return fromB64u(value);
}

async function pushRegistration(){
  if(!("serviceWorker" in navigator) || !("PushManager" in window)){
    throw new Error("Push is not supported on this device.");
  }

  await navigator.serviceWorker.register("/sw.js?v=053",{scope:"/"});
  return navigator.serviceWorker.ready;
}

async function currentPushSubscription(){
  try{
    const reg=await pushRegistration();
    return await reg.pushManager.getSubscription();
  }catch{
    return null;
  }
}

async function updatePushUi(){
  if(!el.enablePush)return;

  if(!state.host || location.pathname!=="/host"){
    el.enablePush.classList.add("hidden");
    return;
  }

  if(!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)){
    el.enablePush.classList.add("hidden");
    return;
  }

  el.enablePush.classList.remove("hidden");

  const sub=await currentPushSubscription();

  if(sub && Notification.permission==="granted"){
    el.enablePush.classList.add("hidden");
    return;
  }else{
    el.enablePush.textContent="ENABLE GAFCHAT ALERTS";
    el.enablePush.disabled=false;
  }
}

async function enableHostPush(){
  try{
    const reg=await pushRegistration();

    const permission=await Notification.requestPermission();

    if(permission!=="granted"){
      throw new Error("Notifications were not enabled.");
    }

    const key=await api("/api/push/public-key");

    if(!key.publicKey){
      throw new Error("GafChat push is not configured.");
    }

    let sub=await reg.pushManager.getSubscription();

    if(!sub){
      sub=await reg.pushManager.subscribe({
        userVisibleOnly:true,
        applicationServerKey:vapidBytes(key.publicKey)
      });
    }

    await api("/api/host/push/subscribe",{
      method:"POST",
      body:JSON.stringify({
        subscription:sub.toJSON()
      })
    });

    toast("GafChat alerts enabled");
    await updatePushUi();

  }catch(e){
    toast(e.message);
  }
}

async function refreshHost(){
  try{
    const d=await api("/api/host/status");

    state.host=d.host;
    state.approvalConfigured=Boolean(d.approvalConfigured);

    try{
      const t=await api("/api/trust/status");
      state.trusted=Boolean(t.trusted);
    }catch{
      state.trusted=false;
    }

    const hostRoute=location.pathname==="/host";
    const hostDashboard=hostRoute&&d.host;

    // Public homepage is always CHAT WITH GAF.
    el.guestCard.classList.toggle("hidden",hostRoute);

    // Host tools only exist on /host.
    el.hostCard.classList.toggle("hidden",!hostDashboard);
    el.hostGate.classList.toggle("hidden",!hostRoute||d.host);

    // /host gets both room creation and incoming requests.
    el.hostName.classList.remove("hidden");
    el.startRoom.classList.remove("hidden");
    el.hostRequestsWrap.classList.toggle("hidden",!hostDashboard);

    const eyebrow=el.hostCard.querySelector(".eyebrow");
    if(eyebrow)eyebrow.textContent="HOST";

    if(hostDashboard){
      renderHostRequests(d.requests||[]);
      updatePushUi();
    }
  }catch{}
}

function renderHostRequests(requests){
  el.hostRequestsList.replaceChildren();

  if(!requests.length){
    const empty=document.createElement("div");
    empty.className="host-request-empty";
    empty.textContent="No one waiting.";
    el.hostRequestsList.appendChild(empty);
    return;
  }

  for(const r of requests){
    const row=document.createElement("div");
    row.className="host-request";

    const name=document.createElement("div");
    name.className="host-request-name";
    name.textContent=r.name;

    const actions=document.createElement("div");
    actions.className="host-request-actions";

    const approve=document.createElement("button");
    approve.textContent="APPROVE";
    approve.className="approve";
    approve.onclick=()=>approveInbound(r,false);

    const save=document.createElement("button");
    save.textContent="SAVE";
    save.className="primary";
    save.onclick=()=>approveInbound(r,true);

    actions.append(approve,save);
    row.append(name,actions);
    el.hostRequestsList.appendChild(row);
  }
}

async function approveInbound(request,save){
  try{
    const keys=await makeChatKeyPair();

    const d=await api(`/api/room-request/${encodeURIComponent(request.id)}/decision`,{
      method:"POST",
      body:JSON.stringify({
        approve:true,
        save,
        hostPub:keys.publicJwk
      })
    });

    const keyString=await deriveChatKey(keys.privateJwk,d.guestPub);

    state.room=d.room;
    state.token=d.token;
    state.member=d.member;
    state.createdAt=d.createdAt;
    state.inviteToken=d.inviteToken||"";
    state.keyString=keyString;
    state.key=await importKey(keyString);

    saveSessionAndOpen();
  }catch(e){
    toast(e.message);
    refreshHost();
  }
}

function saveSessionAndOpen(){
  save();
  history.replaceState(null,"","/");
  openChat();
}

function inviteUrl(){
  const u=new URL(location.origin);
  u.pathname=`/r/${state.room}`;

  const hash=new URLSearchParams();
  hash.set("key",state.keyString);
  hash.set("invite",state.inviteToken);

  u.hash=hash.toString();
  return u.toString();
}
async function hostLogin(){
  try{
    await api("/api/host/login",{method:"POST",body:JSON.stringify({password:el.hostPassword.value})});
    el.hostPassword.value="";await refreshHost();toast("This device is trusted");
  }catch(e){toast(e.message)}
}
function approvalMessage(text,waiting=false){el.approvalState.textContent=text;el.approvalState.classList.remove("hidden");el.approvalState.classList.toggle("waiting",waiting)}
async function confirmOnGafBox(){
  state.hostApprovalAbort?.abort();
  const c=new AbortController();state.hostApprovalAbort=c;
  el.confirmOnGafBox.disabled=true;approvalMessage("Check GafBox on your phone…",true);
  try{
    const d=await api("/api/host/approval/start",{method:"POST",body:"{}"});
    while(!c.signal.aborted){
      await sleep(1200,c.signal);
      const r=await api(`/api/host/approval/status?id=${encodeURIComponent(d.id)}&claim=${encodeURIComponent(d.claim)}`);
      if(r.status==="pending")continue;
      if(r.status==="denied"){approvalMessage("Denied on GafBox.");return}
      if(r.status==="approved"){approvalMessage("Confirmed.");await refreshHost();toast("This device is trusted");return}
    }
  }catch(e){if(e.name!=="AbortError")approvalMessage(e.message)}
  finally{el.confirmOnGafBox.disabled=false}
}
async function startRoom(){err();if(!state.host)return err("Host only.");const name=el.hostName.value.trim()||"Gaf";try{const d=await api("/api/rooms",{method:"POST",body:JSON.stringify({name})});state.room=d.room;state.token=d.token;state.member=d.member;state.createdAt=d.createdAt;state.inviteToken=d.inviteToken||"";state.keyString=b64u(rand(32));state.key=await importKey(state.keyString);save();openChat()}catch(e){err(e.message)}}
async function requestRoom(){
  if(state.inviteRoom&&state.inviteToken)return joinInvitedRoom();
  err("Open an invite link from the room owner to join.");
}

async function joinInvitedRoom(){
  err();

  const name=el.guestName.value.trim()||"Guest";
  const room=state.inviteRoom;
  const inviteToken=state.inviteToken;
  const key=sessionStorage.getItem(`gafchat_key_${room}`)||"";

  if(!name)return err("Enter your name.");
  if(!room||!key||!inviteToken)return err("This invite is incomplete.");

  try{
    const d=await api(`/api/rooms/${room}/join`,{
      method:"POST",
      body:JSON.stringify({name,inviteToken})
    });

    if(d.status!=="approved"){
      throw new Error("Invite could not be accepted.");
    }

    state.room=room;
    state.token=d.token;
    state.member=d.member;
    state.keyString=key;
    state.createdAt=d.createdAt||Date.now();
    state.key=await importKey(key);
    sessionStorage.removeItem("gafchat_pending_invite");
    sessionStorage.removeItem(`gafchat_key_${room}`);

    save();
    history.replaceState(null,"",`/r/${room}`);
    openChat();
  }catch(e){
    err(e.message);
  }
}

function sleep(ms,signal){return new Promise((resolve,reject)=>{const t=setTimeout(resolve,ms);signal.addEventListener("abort",()=>{clearTimeout(t);reject(new DOMException("Aborted","AbortError"))},{once:true})})}
async function waitApproval(id,claim){state.waitAbort?.abort();const c=new AbortController();state.waitAbort=c;try{while(!c.signal.aborted){await sleep(1100,c.signal);const d=await api(`/api/rooms/${state.room}/requests/${encodeURIComponent(id)}?claim=${encodeURIComponent(claim)}`);if(d.status==="denied"){show("landing");err("The room owner declined the request.");return}if(d.status==="approved"){if(d.trustToken){try{await api("/api/trust/enroll",{method:"POST",body:JSON.stringify({token:d.trustToken})});toast("Saved as trusted")}catch(e){console.warn("Trust enrollment:",e.message)}}state.token=d.token;state.member=d.member;save();openChat();return}}}catch(e){if(e.name!=="AbortError"){show("landing");err(e.message)}}}
function openChat(){show("chat");el.roomLabel.textContent="";const owner=Boolean(state.member?.owner);el.burnBtn.classList.toggle("hidden",!owner);document.querySelector(".owner-only-sep")?.classList.toggle("hidden",!owner);connect()}
const alerts={
  unread:0,
  originalTitle:document.title,
  audio:null
};

function unlockAudio(){
  try{
    alerts.audio ||= new (window.AudioContext||window.webkitAudioContext)();
    if(alerts.audio.state==="suspended")alerts.audio.resume();
  }catch{}
}

function ping(){
  try{
    unlockAudio();
    if(!alerts.audio)return;

    const o=alerts.audio.createOscillator();
    const g=alerts.audio.createGain();

    o.frequency.value=660;
    g.gain.setValueAtTime(.045,alerts.audio.currentTime);
    g.gain.exponentialRampToValueAtTime(.001,alerts.audio.currentTime+.12);

    o.connect(g);
    g.connect(alerts.audio.destination);

    o.start();
    o.stop(alerts.audio.currentTime+.12);
  }catch{}
}

async function enableNotifications(){
  if(!("Notification" in window))return;
  if(Notification.permission!=="default")return;

  try{
    await Notification.requestPermission();
  }catch{}
}

function incomingAlert(sender,text){
  ping();

  if(document.hidden || !document.hasFocus()){
    alerts.unread++;
    document.title=`(${alerts.unread}) ${alerts.originalTitle}`;

    if("Notification" in window && Notification.permission==="granted"){
      try{
        new Notification("GafChat",{
          body:"New encrypted message",
          tag:`gafchat-${state.room}`
        });
      }catch{}
    }
  }
}

function clearUnread(){
  alerts.unread=0;
  document.title=alerts.originalTitle;
}

document.addEventListener("visibilitychange",()=>{
  if(!document.hidden)clearUnread();
});

window.addEventListener("focus",clearUnread);

document.addEventListener("pointerdown",()=>{
  unlockAudio();
  enableNotifications();
},{once:true});

function sendTyping(active){
  if(state.ws?.readyState===WebSocket.OPEN){
    state.ws.send(JSON.stringify({type:"typing",active}));
  }
}

function typingBox(){
  let box=document.querySelector("#typingIndicator");
  if(box)return box;

  box=document.createElement("div");
  box.id="typingIndicator";
  box.className="typing-indicator hidden";
  box.innerHTML='<span class="typing-dots"><i></i><i></i><i></i></span><span class="typing-label"></span>';
  el.messages.appendChild(box);
  return box;
}

function renderTyping(){
  const box=typingBox();
  const names=[...state.typing.values()];

  if(!names.length){
    box.classList.add("hidden");
    return;
  }

  box.querySelector(".typing-label").textContent=
    names.length===1
      ? `${names[0]} is typing`
      : `${names.slice(0,2).join(" and ")} are typing`;

  el.messages.appendChild(box);
  box.classList.remove("hidden");
  scroll();
}

function handleTyping(m){
  if(m.sender?.id===state.member?.id)return;

  if(m.active)state.typing.set(m.sender.id,m.sender.name);
  else state.typing.delete(m.sender.id);

  renderTyping();
}

function wsUrl(){const p=location.protocol==="https:"?"wss:":"ws:";return`${p}//${location.host}/ws?room=${encodeURIComponent(state.room)}`}
function fmt(ts){return new Date(ts).toLocaleString([],{month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"})}
async function renderHistory(history){const generation=state.generation;clearObjectUrls();state.reactions.clear();el.messages.replaceChildren();addSystem(`Room started · ${fmt(state.createdAt||Date.now())}`);for(const m of history||[]){if(state.generation!==generation)return;try{if(m.type==="attachment"){await addAttachment(m.sender,m.attachment,m.sender.id===state.member?.id,m.id)}else if(m.type==="message"){const text=await decrypt(m.ciphertext,m.iv);if(state.generation!==generation)return;addMessage(m.sender,text,m.sender.id===state.member?.id,m.id)}else if(m.type==="reaction"){await applyReaction(m)}}catch{if(state.generation===generation)addSystem("Could not decrypt an item.")}}}
async function roomStillExists(){
  if(!state.room||!state.token)return false;
  try{await api(`/api/rooms/${state.room}/status`,{headers:{Authorization:`Bearer ${state.token}`}});return true}catch{return false}
}
function connect(){state.suppressReconnect=false;const ws=new WebSocket(wsUrl(),["gafchat",`auth.${state.token}`]);state.ws=ws;ws.addEventListener("message",async ev=>{if(state.ws!==ws||state.suppressReconnect)return;const generation=state.generation;let m;try{m=JSON.parse(ev.data)}catch{return}if(m.type==="ready"){state.createdAt=m.createdAt||state.createdAt;state.members=m.members||[];state.pending=m.pending||[];state.notices=m.notices||[];save();renderPeople();renderRoomControls();await renderHistory(m.history||[]);return}if(m.type==="presence"){state.members=m.members||[];renderPeople();return}if(m.type==="typing"){handleTyping(m);return}if(m.type==="join_request"){if(state.member?.owner&&!state.pending.some(x=>x.id===m.request.id))state.pending.push(m.request);renderPeople();return}if(m.type==="notice"){if(state.member?.owner&&!state.notices.some(x=>x.id===m.notice.id))state.notices.push(m.notice);renderPeople();return}if(m.type==="booted"){state.suppressReconnect=true;reset();toast("You were removed from this room.");return}if(m.type==="burned"){state.suppressReconnect=true;reset();toast("This room was burned or expired.");return}if(m.type==="reaction"){await applyReaction(m);return}if(m.type==="message"){try{const text=await decrypt(m.ciphertext,m.iv);if(state.generation!==generation)return;const mine=m.sender.id===state.member?.id;state.typing.delete(m.sender.id);renderTyping();addMessage(m.sender,text,mine,m.id);if(!mine)incomingAlert(m.sender,text)}catch{if(state.generation===generation)addSystem("Could not decrypt a message.")};return}if(m.type==="attachment"){try{const mine=m.sender.id===state.member?.id;await addAttachment(m.sender,m.attachment,mine,m.id);if(!mine)incomingAlert(m.sender,"Sent an attachment")}catch{if(state.generation===generation)addSystem("Could not decrypt a file.")}}});ws.addEventListener("close",async e=>{if(state.suppressReconnect||state.ws!==ws||e.code===1000)return;if(!(await roomStillExists())){reset();toast("Room is gone.");return}setTimeout(()=>{if(!state.suppressReconnect&&!el.chat.classList.contains("hidden"))connect()},1000)})}

function humanBytes(n){if(n<1024)return`${n} B`;if(n<1024*1024)return`${(n/1024).toFixed(1)} KB`;return`${(n/1024/1024).toFixed(1)} MB`}
async function fetchAttachment(att){const res=await fetch(`/api/rooms/${state.room}/attachments/${encodeURIComponent(att.id)}`,{cache:"no-store",headers:{Authorization:`Bearer ${state.token}`}});if(!res.ok)throw new Error("File unavailable");const encrypted=await res.arrayBuffer();return decryptBytes(encrypted,att.iv)}
async function addAttachment(sender,att,mine,messageId){
  const generation=state.generation;
  const meta=JSON.parse(await decrypt(att.metaCiphertext,att.metaIv));
  if(state.generation!==generation)return;
  const row=document.createElement("div");
  row.className=`message-row ${mine?"mine":"theirs"}`;

  if(messageId)row.dataset.messageId=messageId;

  if(!mine){
    const who=document.createElement("div");
    who.className="sender";
    who.textContent=sender.name;
    row.appendChild(who);
  }

  const card=document.createElement("div");
  card.className="attachment-card uploading";
  card.textContent="…";
  row.appendChild(card);

  if(messageId)addReactionUi(row,messageId);

  el.messages.appendChild(row);

  if(messageId)renderReactionPills(messageId);

  scroll();

  const plain=await fetchAttachment(att);
  if(state.generation!==generation)return;
  const blob=new Blob([plain],{type:meta.type||"application/octet-stream"});
  const url=URL.createObjectURL(blob);
  state.objectUrls.push(url);

  card.replaceChildren();
  card.classList.remove("uploading");

  if(String(meta.type||"").startsWith("image/")){
    const img=document.createElement("img");
    img.className="attachment-media";
    img.src=url;
    img.alt=meta.name||"Image";
    img.onload=scroll;
    card.appendChild(img);
  }else if(String(meta.type||"").startsWith("video/")){
    const v=document.createElement("video");
    v.className="attachment-media";
    v.src=url;
    v.controls=true;
    v.playsInline=true;
    card.appendChild(v);
  }else{
    const link=document.createElement("a");
    link.className="attachment-file";
    link.href=url;
    link.download=meta.name||"file";

    const icon=document.createElement("span");
    icon.className="attachment-file-icon";
    icon.textContent="📄";

    const name=document.createElement("span");
    name.className="attachment-name";
    name.textContent=meta.name||"File";

    link.append(icon,name);
    card.appendChild(link);
  }

  const info=document.createElement("div");
  info.className="attachment-meta";
  info.textContent=`${meta.name||"File"} · ${humanBytes(meta.size||att.bytes||0)}`;
  card.appendChild(info);

  scroll();
}

async function normalizeUploadFile(file){
  const ext=(file.name.split(".").pop()||"").toLowerCase();

  // Inspect the actual file bytes rather than trusting Apple's filename/MIME.
  const head=new Uint8Array(await file.slice(0,32).arrayBuffer());
  const ascii=String.fromCharCode(...head);

  const looksHeic=/ftyp(?:heic|heix|hevc|hevx|mif1|msf1)/i.test(ascii);
  const saysHeic=ext==="heic"||ext==="heif"||/image\/hei(c|f)/i.test(file.type||"");

  if(!(looksHeic||saysHeic)){
    return file;
  }

  // Use the browser's native decoder; never relax CSP for a third-party codec.
  const url=URL.createObjectURL(file);
  try{
    const img=new Image();img.src=url;await img.decode();
    const canvas=document.createElement("canvas");canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
    if(!canvas.width||!canvas.height||canvas.width*canvas.height>40000000)throw new Error("Unsupported photo size");
    canvas.getContext("2d").drawImage(img,0,0);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",0.92));
    canvas.width=canvas.height=0;
    if(!blob)throw new Error("Conversion unavailable");
    const base=file.name.replace(/\.(heic|heif|jpe?g)$/i,"");
    return new File([blob],`${base}.jpg`,{type:"image/jpeg",lastModified:file.lastModified});
  }catch{
    // Preserve the original as an encrypted downloadable file on other browsers.
    return new File([file],file.name,{type:"application/octet-stream",lastModified:file.lastModified});
  }finally{URL.revokeObjectURL(url)}
}

async function sendFiles(files){if(!files?.length||state.ws?.readyState!==WebSocket.OPEN)return;for(const originalFile of files){let file=originalFile;try{if(file.size>100*1024*1024){toast(`${file.name}: max 100 MB`);continue}file=await normalizeUploadFile(file);if(file.size>100*1024*1024){toast(`${file.name}: max 100 MB`);continue}toast(`Uploading ${file.name}`);const ext=(file.name.split(".").pop()||"").toLowerCase();
const inferredType=file.type||({
  jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",gif:"image/gif",
  webp:"image/webp",heic:"image/heic",heif:"image/heif",
  mov:"video/quicktime",mp4:"video/mp4",m4v:"video/x-m4v"
}[ext]||"application/octet-stream");
const meta=await encrypt(JSON.stringify({name:file.name,type:inferredType,size:file.size}));const enc=await encryptBytes(await file.arrayBuffer());const res=await fetch(`/api/rooms/${state.room}/attachments`,{method:"POST",cache:"no-store",headers:{Authorization:`Bearer ${state.token}`,"Content-Type":"application/octet-stream"},body:enc.ciphertext});const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||"Upload failed");state.ws.send(JSON.stringify({type:"attachment",attachment:{id:data.id,iv:enc.iv,metaIv:meta.iv,metaCiphertext:meta.ciphertext}}));toast("Sent")}catch(e){toast(e.message)}}el.fileInput.value=""}

function reactionMap(messageId){
  if(!state.reactions.has(messageId)){
    state.reactions.set(messageId,new Map());
  }
  return state.reactions.get(messageId);
}

async function sendReaction(messageId,emoji){
  const map=reactionMap(messageId);
  const current=map.get(state.member?.id)||"";
  const next=current===emoji ? "" : emoji;

  const payload=await encrypt(JSON.stringify({emoji:next}));

  if(state.ws?.readyState===WebSocket.OPEN){
    state.ws.send(JSON.stringify({
      type:"reaction",
      targetId:messageId,
      ...payload
    }));
  }
}

async function applyReaction(m){
  const generation=state.generation;
  try{
    const payload=JSON.parse(await decrypt(m.ciphertext,m.iv));
    if(state.generation!==generation)return;
    const map=reactionMap(m.targetId);

    if(payload.emoji){
      map.set(m.sender.id,payload.emoji);
    }else{
      map.delete(m.sender.id);
    }

    renderReactionPills(m.targetId);
  }catch{}
}

function renderReactionPills(messageId){
  const row=el.messages.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if(!row)return;

  const map=reactionMap(messageId);
  const mine=map.get(state.member?.id)||"";

  const trigger=row.querySelector(".react-trigger");
  if(trigger){
    trigger.textContent=mine||"＋";
    trigger.classList.toggle("reacted",Boolean(mine));
  }

  let wrap=row.querySelector(".reaction-pills");

  if(!wrap){
    wrap=document.createElement("div");
    wrap.className="reaction-pills";
    row.appendChild(wrap);
  }

  wrap.replaceChildren();

  const counts=new Map();

  for(const [senderId,emoji] of map.entries()){
    if(senderId===state.member?.id)continue;
    counts.set(emoji,(counts.get(emoji)||0)+1);
  }

  for(const [emoji,count] of counts){
    const b=document.createElement("button");
    b.type="button";
    b.className="reaction-pill";
    b.textContent=`${emoji}${count>1?` ${count}`:""}`;
    b.onclick=()=>sendReaction(messageId,emoji);
    wrap.appendChild(b);
  }

  wrap.classList.toggle("hidden",counts.size===0);
}

function addReactionUi(row,messageId){
  if(!messageId)return;

  const trigger=document.createElement("button");
  trigger.type="button";
  trigger.className="react-trigger";
  trigger.textContent="＋";

  const tray=document.createElement("div");
  tray.className="reaction-tray hidden";

  for(const emoji of ["👍","❤️","😂","😮","😢","😡","🔥"]){
    const b=document.createElement("button");
    b.type="button";
    b.textContent=emoji;
    b.onclick=()=>{
      sendReaction(messageId,emoji);
      tray.classList.add("hidden");
    };
    tray.appendChild(b);
  }

  trigger.onclick=()=>{
    const current=reactionMap(messageId).get(state.member?.id)||"";

    if(current){
      sendReaction(messageId,current);
      tray.classList.add("hidden");
      return;
    }

    tray.classList.toggle("hidden");
  };

  row.append(trigger,tray);
}

function richText(container,text){
  const input=String(text||"");
  const urlRe=/https?:\/\/[^\s<]+/gi;
  let last=0;

  for(const match of input.matchAll(urlRe)){
    const raw=match[0];
    const start=match.index;

    if(start>last){
      container.append(document.createTextNode(input.slice(last,start)));
    }

    let url;

    try{
      url=new URL(raw);
    }catch{
      container.append(document.createTextNode(raw));
      last=start+raw.length;
      continue;
    }

    if(url.protocol!=="http:" && url.protocol!=="https:"){
      container.append(document.createTextNode(raw));
      last=start+raw.length;
      continue;
    }

    const link=document.createElement("a");
    link.href=url.href;
    link.target="_blank";
    link.rel="noopener noreferrer";
    link.textContent=raw;

    container.append(link);

    last=start+raw.length;
  }

  if(last<input.length){
    container.append(document.createTextNode(input.slice(last)));
  }
}

function addSystem(t){const d=document.createElement("div");d.className="system";d.textContent=t;el.messages.appendChild(d);scroll()}function addMessage(sender,text,mine,messageId){const row=document.createElement("div");row.className=`message-row ${mine?"mine":"theirs"}`;if(messageId)row.dataset.messageId=messageId;if(!mine){const s=document.createElement("div");s.className="sender";s.textContent=sender.name;row.appendChild(s)}const b=document.createElement("div");b.className="bubble";richText(b,text);row.appendChild(b);if(messageId)addReactionUi(row,messageId);el.messages.appendChild(row);if(messageId)renderReactionPills(messageId);scroll()}function scroll(){requestAnimationFrame(()=>el.messages.scrollTop=el.messages.scrollHeight)}
function renderRoomControls(){
  const owner=Boolean(state.member?.owner);
  el.leaveBtn.classList.toggle("hidden",owner);
  el.burnBtn.classList.toggle("hidden",!owner);
}

function renderPeople(){el.memberList.replaceChildren();for(const m of state.members){const row=document.createElement("div");row.className="person";const name=document.createElement("span");name.textContent=`${m.name}${m.owner?" · owner":""}${m.id===state.member?.id?" · you":""}`;row.appendChild(name);if(state.member?.owner&&!m.owner){const a=document.createElement("div");a.className="actions";const boot=document.createElement("button");boot.className="boot";boot.textContent="BOOT";boot.onclick=()=>bootMember(m);a.appendChild(boot);row.appendChild(a)}el.memberList.appendChild(row)}el.pendingList.replaceChildren();el.noticeList.replaceChildren();const p=state.member?.owner?state.pending.length:0,n=state.member?.owner?state.notices.length:0;el.pendingWrap.classList.toggle("hidden",p===0);el.noticeWrap.classList.toggle("hidden",n===0);const total=p+n;el.peopleBadge.textContent=String(total);el.peopleBadge.classList.toggle("hidden",total===0);el.alertBar.classList.toggle("hidden",p===0);if(p)el.alertText.textContent=p===1?`${state.pending[0].name} wants to join`:`${p} people want to join`;if(state.member?.owner){for(const r of state.pending){const row=document.createElement("div");row.className="request";const name=document.createElement("span");name.textContent=r.name;const a=document.createElement("div");a.className="actions";const no=document.createElement("button");no.className="deny";no.textContent="DENY";no.onclick=()=>decide(r.id,false);const yes=document.createElement("button");yes.className="approve";yes.textContent="APPROVE";yes.onclick=()=>decide(r.id,true);const saveBtn=document.createElement("button");saveBtn.className="approve";saveBtn.textContent="SAVE";saveBtn.onclick=()=>decide(r.id,true,true);a.append(no,yes,saveBtn);row.append(name,a);el.pendingList.appendChild(row)}for(const notice of state.notices){const row=document.createElement("div");row.className="notice";const t=document.createElement("span");t.textContent=notice.text;const clear=document.createElement("button");clear.className="clear-notice";clear.textContent="CLEAR";clear.onclick=()=>clearNotice(notice.id);row.append(t,clear);el.noticeList.appendChild(row)}}}
async function decide(id,approve,save=false){try{await api(`/api/rooms/${state.room}/approve`,{method:"POST",body:JSON.stringify({token:state.token,requestId:id,approve,save})});state.pending=state.pending.filter(x=>x.id!==id);renderPeople();if(save)toast("Saved as trusted")}catch(e){toast(e.message)}}async function clearNotice(id){try{await api(`/api/rooms/${state.room}/notices/${encodeURIComponent(id)}`,{method:"DELETE",headers:{Authorization:`Bearer ${state.token}`}});state.notices=state.notices.filter(x=>x.id!==id);renderPeople()}catch(e){toast(e.message)}}async function bootMember(m){if(!confirm(`Boot ${m.name}?`))return;try{await api(`/api/rooms/${state.room}/boot`,{method:"POST",body:JSON.stringify({token:state.token,memberId:m.id})})}catch(e){toast(e.message)}}async function burnRoom(){
  try{
    await api(`/api/rooms/${state.room}/burn`,{
      method:"POST",
      body:JSON.stringify({token:state.token})
    });

    history.replaceState(null,"","/host");
    reset();
    toast("Room burned");
  }catch(e){
    toast(e.message);
  }
}async function copyInvite(){
  try{
    const url=inviteUrl();

    if(navigator.share){
      await navigator.share({
        title:"GafChat",
        text:"Join me on GafChat",
        url
      });
      toast("Invite shared");
    }else{
      await navigator.clipboard.writeText(url);
      toast("Invite copied");
    }
  }catch(e){
    if(e?.name!=="AbortError")toast(e.message||"Could not share invite");
  }
}async function sendMessage(e){e.preventDefault();const text=el.messageInput.value.trim();if(!text||state.ws?.readyState!==WebSocket.OPEN)return;clearTimeout(state.typingTimer);sendTyping(false);const payload=await encrypt(text);state.ws.send(JSON.stringify({type:"message",...payload}));el.messageInput.value=""}
el.startRoom.onclick=startRoom;
if(el.enablePush)el.enablePush.onclick=enableHostPush;
el.requestRoom.onclick=requestRoom;
el.confirmOnGafBox.onclick=confirmOnGafBox;
el.recoveryToggle.onclick=()=>el.recoveryWrap.classList.toggle("hidden");
el.confirmHost.onclick=hostLogin;
el.hostPassword.addEventListener("keydown",e=>{if(e.key==="Enter")hostLogin()});
el.inviteBtn.onclick=copyInvite;
el.attachBtn.onclick=()=>el.fileInput.click();
el.fileInput.onchange=()=>sendFiles([...el.fileInput.files]);
el.peopleBtn.onclick=()=>el.peoplePanel.classList.toggle("hidden");
el.reviewBtn.onclick=()=>el.peoplePanel.classList.remove("hidden");
el.closePeople.onclick=()=>el.peoplePanel.classList.add("hidden");
el.leaveBtn.onclick=reset;
el.burnBtn.onclick=()=>el.burnModal.classList.remove("hidden");
el.cancelBurn.onclick=()=>el.burnModal.classList.add("hidden");
el.confirmBurn.onclick=burnRoom;
el.composer.addEventListener("submit",sendMessage);
el.messageInput.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();el.composer.requestSubmit()}});
el.messageInput.addEventListener("input",()=>{
  sendTyping(true);
  clearTimeout(state.typingTimer);
  state.typingTimer=setTimeout(()=>sendTyping(false),1100);
});
(async()=>{
  await refreshHost();
  if(!(await readInvite()))await restore();
})().catch(()=>{sessionStorage.removeItem("gafchat_session");show("landing");err("Could not open this chat. Ask for a fresh invite link.")});
