const $=s=>document.querySelector(s);
const el={landing:$("#landing"),waiting:$("#waiting"),chat:$("#chat"),hostCard:$("#hostCard"),guestCard:$("#guestCard"),hostGate:$("#hostGate"),hostName:$("#hostName"),guestName:$("#guestName"),joinCode:$("#joinCode"),startRoom:$("#startRoom"),joinRoom:$("#joinRoom"),requestRoom:$("#requestRoom"),confirmOnGafBox:$("#confirmOnGafBox"),approvalState:$("#approvalState"),recoveryToggle:$("#recoveryToggle"),recoveryWrap:$("#recoveryWrap"),hostPassword:$("#hostPassword"),confirmHost:$("#confirmHost"),landingError:$("#landingError"),cancelWait:$("#cancelWait"),roomLabel:$("#roomLabel"),inviteBtn:$("#inviteBtn"),peopleBtn:$("#peopleBtn"),peopleBadge:$("#peopleBadge"),leaveBtn:$("#leaveBtn"),burnBtn:$("#burnBtn"),alertBar:$("#alertBar"),alertText:$("#alertText"),reviewBtn:$("#reviewBtn"),peoplePanel:$("#peoplePanel"),closePeople:$("#closePeople"),pendingWrap:$("#pendingWrap"),pendingList:$("#pendingList"),noticeWrap:$("#noticeWrap"),noticeList:$("#noticeList"),memberList:$("#memberList"),messages:$("#messages"),composer:$("#composer"),messageInput:$("#messageInput"),toast:$("#toast"),burnModal:$("#burnModal"),cancelBurn:$("#cancelBurn"),confirmBurn:$("#confirmBurn"),attachBtn:$("#attachBtn"),fileInput:$("#fileInput")};
const state={room:"",token:"",member:null,keyString:"",key:null,ws:null,members:[],pending:[],notices:[],createdAt:null,waitAbort:null,suppressReconnect:false,host:false,trusted:false,approvalConfigured:false,hostApprovalAbort:null,objectUrls:[]};
function show(which){[el.landing,el.waiting,el.chat].forEach(x=>x.classList.add("hidden"));el[which].classList.remove("hidden")}
function err(t=""){el.landingError.textContent=t}
function toast(t){el.toast.textContent=t;el.toast.classList.remove("hidden");clearTimeout(toast._t);toast._t=setTimeout(()=>el.toast.classList.add("hidden"),1800)}
async function api(path,options={}){const res=await fetch(path,{cache:"no-store",headers:{"Content-Type":"application/json",...(options.headers||{})},...options});const data=await res.json().catch(()=>({error:"Bad server response."}));if(!res.ok)throw new Error(data.error||`Request failed (${res.status})`);return data}
const normalize=v=>String(v||"").toUpperCase().replace(/[^A-Z2-9]/g,"").slice(0,6);
function rand(n){const a=new Uint8Array(n);crypto.getRandomValues(a);return a}function b64u(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"")}function fromB64u(v){const s=v.replace(/-/g,"+").replace(/_/g,"/"),p=s+"=".repeat((4-s.length%4)%4);return Uint8Array.from(atob(p),c=>c.charCodeAt(0))}async function importKey(k){return crypto.subtle.importKey("raw",fromB64u(k),{name:"AES-GCM"},false,["encrypt","decrypt"])}
async function encrypt(text){const iv=rand(12);const out=await crypto.subtle.encrypt({name:"AES-GCM",iv},state.key,new TextEncoder().encode(text));return{iv:b64u(iv),ciphertext:b64u(new Uint8Array(out))}}async function decrypt(ciphertext,iv){const out=await crypto.subtle.decrypt({name:"AES-GCM",iv:fromB64u(iv)},state.key,fromB64u(ciphertext));return new TextDecoder().decode(out)}
async function encryptBytes(buffer){const iv=rand(12);const out=await crypto.subtle.encrypt({name:"AES-GCM",iv},state.key,buffer);return{iv:b64u(iv),ciphertext:out}}
async function decryptBytes(buffer,iv){return crypto.subtle.decrypt({name:"AES-GCM",iv:fromB64u(iv)},state.key,buffer)}
function clearObjectUrls(){for(const u of state.objectUrls)URL.revokeObjectURL(u);state.objectUrls=[]}
function save(){sessionStorage.setItem("gafchat_session",JSON.stringify({room:state.room,token:state.token,member:state.member,keyString:state.keyString,createdAt:state.createdAt}))}
function reset(){state.suppressReconnect=true;if(state.ws?.readyState===WebSocket.OPEN){try{state.ws.send(JSON.stringify({type:"leave"}))}catch{}}state.ws?.close(1000);sessionStorage.removeItem("gafchat_session");clearObjectUrls();Object.assign(state,{room:"",token:"",member:null,keyString:"",key:null,ws:null,members:[],pending:[],notices:[],createdAt:null});el.messages.replaceChildren();el.peoplePanel.classList.add("hidden");el.burnModal.classList.add("hidden");show("landing");refreshHost()}
async function readInvite(){
  const q=new URLSearchParams(location.search),h=new URLSearchParams(location.hash.slice(1));
  const pathRoom=(location.pathname.match(/^\/r\/([A-Z0-9]{6})$/i)||[])[1]||"";
  const room=normalize(pathRoom||q.get("room")),key=h.get("key")||"",trust=h.get("trust")||"";

  if(room)el.joinCode.value=room;
  if(key)sessionStorage.setItem(`gafchat_key_${room}`,key);

  if(trust){
    try{
      const d=await api("/api/trust/enroll",{method:"POST",body:JSON.stringify({token:trust})});
      if(d.trusted)toast(`${d.label||"This device"} is now trusted`);
    }catch(e){
      console.warn("Trust enrollment:",e.message);
    }
  }

  history.replaceState(null,"",room?`/r/${room}`:"/");
}
async function restore(){let s;try{s=JSON.parse(sessionStorage.getItem("gafchat_session")||"null")}catch{return}if(!s?.room||!s?.token||!s?.member||!s?.keyString)return;Object.assign(state,s);state.key=await importKey(s.keyString);openChat()}
async function refreshHost(){
  try{
    const d=await api("/api/host/status");
    state.host=d.host;state.approvalConfigured=Boolean(d.approvalConfigured);
    try{const t=await api("/api/trust/status");state.trusted=Boolean(t.trusted)}catch{state.trusted=false}
    const hostRoute=location.pathname==="/host";
    el.hostCard.classList.toggle("hidden",!(d.host||state.trusted));
    el.guestCard.classList.toggle("hidden",d.host||state.trusted||hostRoute);

    const eyebrow=el.hostCard.querySelector(".eyebrow");
    if(eyebrow)eyebrow.textContent=d.host?"HOST":"TRUSTED";
    if(state.trusted&&!d.host&&el.hostName.value==="Gaf")el.hostName.value="";
    el.hostGate.classList.toggle("hidden",d.host||!hostRoute);
    if(hostRoute&&d.host) history.replaceState(null,"","/");
  }catch{}
}
function inviteUrl(trustToken=""){
  const u=new URL(location.origin);
  u.pathname=`/r/${state.room}`;
  const h=new URLSearchParams();
  h.set("key",state.keyString);
  if(trustToken)h.set("trust",trustToken);
  u.hash=h.toString();
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
async function startRoom(){err();if(!(state.host||state.trusted))return err("Trusted device only.");const name=el.hostName.value.trim()||"Gaf";try{const d=await api("/api/rooms",{method:"POST",body:JSON.stringify({name})});state.room=d.room;state.token=d.token;state.member=d.member;state.createdAt=d.createdAt;state.keyString=b64u(rand(32));state.key=await importKey(state.keyString);save();openChat()}catch(e){err(e.message)}}
async function requestRoom(){const name=el.guestName.value.trim()||"Someone";try{const d=await api("/api/room-request",{method:"POST",body:JSON.stringify({name})});toast(d.delivered?"Request sent to GafBox":"Request saved for Gaf")}catch(e){toast(e.message)}}
async function joinRoom(){err();const name=el.guestName.value.trim(),room=normalize(el.joinCode.value),key=sessionStorage.getItem(`gafchat_key_${room}`)||"";if(!name)return err("Enter your name.");if(room.length!==6)return err("Enter the room code.");if(!key)return err("Open the full invite link from the room owner.");try{const d=await api(`/api/rooms/${room}/join`,{method:"POST",body:JSON.stringify({name})});state.room=room;state.keyString=key;state.key=await importKey(key);if(d.status==="approved"){state.token=d.token;state.member=d.member;save();openChat();return}show("waiting");waitApproval(d.requestId,d.claimToken)}catch(e){err(e.message)}}
function sleep(ms,signal){return new Promise((resolve,reject)=>{const t=setTimeout(resolve,ms);signal.addEventListener("abort",()=>{clearTimeout(t);reject(new DOMException("Aborted","AbortError"))},{once:true})})}
async function waitApproval(id,claim){state.waitAbort?.abort();const c=new AbortController();state.waitAbort=c;try{while(!c.signal.aborted){await sleep(1100,c.signal);const d=await api(`/api/rooms/${state.room}/requests/${encodeURIComponent(id)}?claim=${encodeURIComponent(claim)}`);if(d.status==="denied"){show("landing");err("The room owner declined the request.");return}if(d.status==="approved"){state.token=d.token;state.member=d.member;save();openChat();return}}}catch(e){if(e.name!=="AbortError"){show("landing");err(e.message)}}}
function openChat(){show("chat");el.roomLabel.innerHTML=`ROOM CODE:<span class="room-code-value">${state.room}</span>`;const owner=Boolean(state.member?.owner);el.burnBtn.classList.toggle("hidden",!owner);document.querySelector(".owner-only-sep")?.classList.toggle("hidden",!owner);connect()}
function wsUrl(){const p=location.protocol==="https:"?"wss:":"ws:";return`${p}//${location.host}/ws?room=${encodeURIComponent(state.room)}&token=${encodeURIComponent(state.token)}`}
function fmt(ts){return new Date(ts).toLocaleString([],{month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"})}
async function renderHistory(history){clearObjectUrls();el.messages.replaceChildren();addSystem(`Room started · ${fmt(state.createdAt||Date.now())}`);for(const m of history||[]){try{if(m.type==="attachment")await addAttachment(m.sender,m.attachment,m.sender.id===state.member?.id);else{const text=await decrypt(m.ciphertext,m.iv);addMessage(m.sender,text,m.sender.id===state.member?.id)}}catch{addSystem("Could not decrypt an item.")}}}
async function roomStillExists(){
  if(!state.room||!state.token)return false;
  try{await api(`/api/rooms/${state.room}/status?token=${encodeURIComponent(state.token)}`);return true}catch{return false}
}
function connect(){state.suppressReconnect=false;const ws=new WebSocket(wsUrl());state.ws=ws;ws.addEventListener("message",async ev=>{let m;try{m=JSON.parse(ev.data)}catch{return}if(m.type==="ready"){state.createdAt=m.createdAt||state.createdAt;state.members=m.members||[];state.pending=m.pending||[];state.notices=m.notices||[];save();renderPeople();await renderHistory(m.history||[]);return}if(m.type==="presence"){state.members=m.members||[];renderPeople();return}if(m.type==="join_request"){if(state.member?.owner&&!state.pending.some(x=>x.id===m.request.id))state.pending.push(m.request);renderPeople();return}if(m.type==="notice"){if(state.member?.owner&&!state.notices.some(x=>x.id===m.notice.id))state.notices.push(m.notice);renderPeople();return}if(m.type==="booted"){state.suppressReconnect=true;alert("You were removed from this room.");reset();return}if(m.type==="burned"){state.suppressReconnect=true;alert("This room was burned.");reset();return}if(m.type==="message"){try{const text=await decrypt(m.ciphertext,m.iv);addMessage(m.sender,text,m.sender.id===state.member?.id)}catch{addSystem("Could not decrypt a message.")};return}if(m.type==="attachment"){try{await addAttachment(m.sender,m.attachment,m.sender.id===state.member?.id)}catch{addSystem("Could not decrypt a file.")}}});ws.addEventListener("close",async e=>{if(state.suppressReconnect||state.ws!==ws||e.code===1000)return;if(!(await roomStillExists())){state.suppressReconnect=true;toast("Room is gone.");setTimeout(()=>reset(),500);return}setTimeout(()=>{if(!state.suppressReconnect&&!el.chat.classList.contains("hidden"))connect()},1000)})}

function humanBytes(n){if(n<1024)return`${n} B`;if(n<1024*1024)return`${(n/1024).toFixed(1)} KB`;return`${(n/1024/1024).toFixed(1)} MB`}
async function fetchAttachment(att){const res=await fetch(`/api/rooms/${state.room}/attachments/${encodeURIComponent(att.id)}`,{cache:"no-store",headers:{Authorization:`Bearer ${state.token}`}});if(!res.ok)throw new Error("File unavailable");const encrypted=await res.arrayBuffer();return decryptBytes(encrypted,att.iv)}
async function addAttachment(sender,att,mine){const meta=JSON.parse(await decrypt(att.metaCiphertext,att.metaIv));const row=document.createElement("div");row.className=`message-row ${mine?"mine":"theirs"}`;if(!mine){const who=document.createElement("div");who.className="sender";who.textContent=sender.name;row.appendChild(who)}const card=document.createElement("div");card.className="attachment-card uploading";card.textContent="…";row.appendChild(card);el.messages.appendChild(row);scroll();const plain=await fetchAttachment(att);const blob=new Blob([plain],{type:meta.type||"application/octet-stream"});const url=URL.createObjectURL(blob);state.objectUrls.push(url);card.replaceChildren();card.classList.remove("uploading");if(String(meta.type||"").startsWith("image/")){const img=document.createElement("img");img.className="attachment-media";img.src=url;img.alt=meta.name||"Image";img.onload=scroll;card.appendChild(img)}else if(String(meta.type||"").startsWith("video/")){const v=document.createElement("video");v.className="attachment-media";v.src=url;v.controls=true;v.playsInline=true;card.appendChild(v)}else{const a=document.createElement("a");a.className="attachment-file";a.href=url;a.download=meta.name||"file";const icon=document.createElement("span");icon.className="attachment-file-icon";icon.textContent="📄";const name=document.createElement("span");name.className="attachment-name";name.textContent=meta.name||"File";a.append(icon,name);card.appendChild(a)}const info=document.createElement("div");info.className="attachment-meta";info.textContent=`${meta.name||"File"} · ${humanBytes(meta.size||att.bytes||0)}`;card.appendChild(info);scroll()}

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

  if(typeof window.heic2any!=="function"){
    throw new Error("Photo converter failed to load.");
  }

  toast(`Converting ${file.name}`);

  const result=await window.heic2any({
    blob:file,
    toType:"image/jpeg",
    quality:0.92
  });

  const blob=Array.isArray(result)?result[0]:result;
  const base=file.name.replace(/\.(heic|heif|jpe?g)$/i,"");

  return new File([blob],`${base}.jpg`,{
    type:"image/jpeg",
    lastModified:file.lastModified
  });
}

async function sendFiles(files){if(!files?.length||state.ws?.readyState!==WebSocket.OPEN)return;for(const originalFile of files){let file=originalFile;try{if(file.size>100*1024*1024){toast(`${file.name}: max 100 MB`);continue}file=await normalizeUploadFile(file);if(file.size>100*1024*1024){toast(`${file.name}: max 100 MB`);continue}toast(`Uploading ${file.name}`);const ext=(file.name.split(".").pop()||"").toLowerCase();
const inferredType=file.type||({
  jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",gif:"image/gif",
  webp:"image/webp",heic:"image/heic",heif:"image/heif",
  mov:"video/quicktime",mp4:"video/mp4",m4v:"video/x-m4v"
}[ext]||"application/octet-stream");
const meta=await encrypt(JSON.stringify({name:file.name,type:inferredType,size:file.size}));const enc=await encryptBytes(await file.arrayBuffer());const res=await fetch(`/api/rooms/${state.room}/attachments`,{method:"POST",cache:"no-store",headers:{Authorization:`Bearer ${state.token}`,"Content-Type":"application/octet-stream"},body:enc.ciphertext});const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||"Upload failed");state.ws.send(JSON.stringify({type:"attachment",attachment:{id:data.id,iv:enc.iv,metaIv:meta.iv,metaCiphertext:meta.ciphertext}}));toast("Sent")}catch(e){toast(e.message)}}el.fileInput.value=""}

function addSystem(t){const d=document.createElement("div");d.className="system";d.textContent=t;el.messages.appendChild(d);scroll()}function addMessage(sender,text,mine){const row=document.createElement("div");row.className=`message-row ${mine?"mine":"theirs"}`;if(!mine){const s=document.createElement("div");s.className="sender";s.textContent=sender.name;row.appendChild(s)}const b=document.createElement("div");b.className="bubble";b.textContent=text;row.appendChild(b);el.messages.appendChild(row);scroll()}function scroll(){requestAnimationFrame(()=>el.messages.scrollTop=el.messages.scrollHeight)}
function renderPeople(){el.memberList.replaceChildren();for(const m of state.members){const row=document.createElement("div");row.className="person";const name=document.createElement("span");name.textContent=`${m.name}${m.owner?" · owner":""}${m.id===state.member?.id?" · you":""}`;row.appendChild(name);if(state.member?.owner&&!m.owner){const a=document.createElement("div");a.className="actions";const boot=document.createElement("button");boot.className="boot";boot.textContent="BOOT";boot.onclick=()=>bootMember(m);a.appendChild(boot);row.appendChild(a)}el.memberList.appendChild(row)}el.pendingList.replaceChildren();el.noticeList.replaceChildren();const p=state.member?.owner?state.pending.length:0,n=state.member?.owner?state.notices.length:0;el.pendingWrap.classList.toggle("hidden",p===0);el.noticeWrap.classList.toggle("hidden",n===0);const total=p+n;el.peopleBadge.textContent=String(total);el.peopleBadge.classList.toggle("hidden",total===0);el.alertBar.classList.toggle("hidden",total===0);if(p)el.alertText.textContent=p===1?`${state.pending[0].name} wants to join`:`${p} people want to join`;else if(n)el.alertText.textContent=state.notices[0].text;if(state.member?.owner){for(const r of state.pending){const row=document.createElement("div");row.className="request";const name=document.createElement("span");name.textContent=r.name;const a=document.createElement("div");a.className="actions";const no=document.createElement("button");no.className="deny";no.textContent="DENY";no.onclick=()=>decide(r.id,false);const yes=document.createElement("button");yes.className="approve";yes.textContent="APPROVE";yes.onclick=()=>decide(r.id,true);a.append(no,yes);row.append(name,a);el.pendingList.appendChild(row)}for(const notice of state.notices){const row=document.createElement("div");row.className="notice";const t=document.createElement("span");t.textContent=notice.text;const clear=document.createElement("button");clear.className="clear-notice";clear.textContent="CLEAR";clear.onclick=()=>clearNotice(notice.id);row.append(t,clear);el.noticeList.appendChild(row)}}}
async function decide(id,approve){try{await api(`/api/rooms/${state.room}/approve`,{method:"POST",body:JSON.stringify({token:state.token,requestId:id,approve})});state.pending=state.pending.filter(x=>x.id!==id);renderPeople()}catch(e){toast(e.message)}}async function clearNotice(id){try{await api(`/api/rooms/${state.room}/notices/${encodeURIComponent(id)}?token=${encodeURIComponent(state.token)}`,{method:"DELETE"});state.notices=state.notices.filter(x=>x.id!==id);renderPeople()}catch(e){toast(e.message)}}async function bootMember(m){if(!confirm(`Boot ${m.name}?`))return;try{await api(`/api/rooms/${state.room}/boot`,{method:"POST",body:JSON.stringify({token:state.token,memberId:m.id})})}catch(e){toast(e.message)}}async function burnRoom(){try{await api(`/api/rooms/${state.room}/burn`,{method:"POST",body:JSON.stringify({token:state.token})});reset();toast("Room burned")}catch(e){toast(e.message)}}async function copyInvite(){
  try{
    let trustToken="";

    if(state.host && confirm("Trust this person for future GafChat rooms?")){
      const label=prompt("Name or phone number (optional):","")?.trim()||"Trusted person";
      const d=await api("/api/trust/invite",{method:"POST",body:JSON.stringify({label})});
      trustToken=d.token;
    }

    const url=inviteUrl(trustToken);

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
}async function sendMessage(e){e.preventDefault();const text=el.messageInput.value.trim();if(!text||state.ws?.readyState!==WebSocket.OPEN)return;const payload=await encrypt(text);state.ws.send(JSON.stringify({type:"message",...payload}));el.messageInput.value=""}
el.joinCode.addEventListener("input",()=>el.joinCode.value=normalize(el.joinCode.value));
el.startRoom.onclick=startRoom;
el.joinRoom.onclick=joinRoom;
el.requestRoom.onclick=requestRoom;
el.confirmOnGafBox.onclick=confirmOnGafBox;
el.recoveryToggle.onclick=()=>el.recoveryWrap.classList.toggle("hidden");
el.confirmHost.onclick=hostLogin;
el.hostPassword.addEventListener("keydown",e=>{if(e.key==="Enter")hostLogin()});
el.cancelWait.onclick=()=>{state.waitAbort?.abort();show("landing")};
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
readInvite();
refreshHost();
restore().catch(()=>{sessionStorage.removeItem("gafchat_session");show("landing")});
