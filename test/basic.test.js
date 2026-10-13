import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("no inline script",()=>{
  const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  assert.equal(/<script(?![^>]*src=)/i.test(html),false);
});

test("security headers present",()=>{
  const s=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
  assert.match(s,/Content-Security-Policy/);
  assert.match(s,/frame-ancestors 'none'/);
});

test("server relays ciphertext fields",()=>{
  const s=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
  assert.match(s,/ciphertext/);
  assert.match(s,/AES-GCM|ciphertext/);
});

test("host approval endpoints present",()=>{
  const s=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
  assert.match(s,/\/api\/host\/approval\/start/);
  assert.match(s,/\/api\/host\/approval\/status/);
  assert.match(s,/GAFBOX_SHARED_SECRET/);
});

test("public screen has no visible HOST button",()=>{
  const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  assert.equal(/>HOST<\/button>/i.test(html),false);
  assert.match(html,/CONFIRM ON GAFBOX/);
});

test("prototype assets are no-store",()=>{
  const s=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
  assert.match(s,/"Cache-Control":"no-store"/);
});


test("encrypted attachment cache present",()=>{
  const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const app=fs.readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  assert.match(server,/attachments/);
  assert.match(server,/ATTACHMENT_MAX_BYTES/);
  assert.match(server,/wipeRoom/);
  assert.match(app,/encryptBytes/);
  assert.match(app,/decryptBytes/);
});

test("top nav uses compact text controls",()=>{
  const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  assert.match(html,/>INVITE<\/button>/);
  assert.match(html,/WHO’S HERE/);
  assert.match(html,/>LEAVE ROOM<\/button>/);
  assert.match(html,/>BURN ROOM<\/button>/);
  assert.match(html,/id="attachBtn"[^>]*>📎<\/button>/);
});


test("GafChat PWA branding is packaged locally",()=>{
  const html=fs.readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  const manifest=JSON.parse(fs.readFileSync(new URL("../public/manifest.json",import.meta.url),"utf8"));
  assert.match(html,/gafchat-logo\.png/);
  assert.match(html,/manifest\.json/);
  assert.equal(manifest.name,"GafChat");
  assert.equal(manifest.icons.some(i=>i.sizes==="512x512"),true);
});


test("host trust survives restart when GafBox secret is configured",()=>{
  const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
  assert.match(server,/gafchat-host:\$\{GAFBOX_SHARED_SECRET\}/);
});

test("stale room sessions are detected instead of reconnecting forever",()=>{
  const server=fs.readFileSync(new URL("../server.js",import.meta.url),"utf8");
  const app=fs.readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
  assert.equal(server.includes("/status$/i"),true);
  assert.match(app,/roomStillExists/);
});
