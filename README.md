# GafChat

Private, temporary, self-hosted encrypted chat.

Current snapshot: **v0.5.4**, synced with the running installation on October 29, 2026.

Confirmed working on the live installation. The `stable/v0.5.4` branch preserves this build; see [release notes](RELEASE_NOTES.md).

## What it does

- Invite-only rooms with short room codes and shareable `/r/CODE` links.
- Browser-side AES-GCM encryption for message text, attachment metadata and attachment bytes.
- The room key travels in the URL fragment, so it is not sent to the server as part of the HTTP request.
- Photos, video and files render or download after decrypting in the recipient browser.
- HEIC/HEIF photos are converted before encryption when the browser supports native decoding; otherwise the original is sent as an encrypted downloadable file.
- The example configuration limits attachments to 25 MB per file and 100 MB total attachment cache per room.
- Rooms, message history and encrypted attachments live in server memory and disappear on burn, expiry or server restart. Rooms have a six-hour absolute lifetime by default, including while connected.
- Room owners can remove participants and burn the room.
- Only authenticated Host devices can create rooms. Guests need a valid full invitation; saved device trust never substitutes for an invite.
- Social preview metadata and a 1200×630 share card are included.
- Secure invite tokens, typing indicators, encrypted emoji reactions and clickable links.
- Installed PWA opens `/host`; host burn returns there, and guests can leave.
- Mobile sizing and room controls retain the v0.5.2 layout. The public homepage redirects unauthenticated visitors to the configured `GUEST_REDIRECT_URL` (`https://gaf.nyc/` on the original installation) and authenticated Hosts to `/host`. A full invitation opens its room directly as Guest. Guests are redirected to the same configured destination after leaving, burn or expiry. The portable default is `https://example.com/`; set your own destination before deployment. `/host` retains the authenticated host recovery/login gate. The old public chat-request/approval flow is disabled. Invalid or incomplete invitations show an error rather than entering an approval queue. The host start card shows only the logo, name field and START A ROOM button.

## Quick start

```bash
npm ci
cp .env.example .env
# Edit .env for your deployment, then load it into the shell:
set -a
. ./.env
set +a
npm start
```

GafChat reads configuration from process environment variables; it does not automatically parse `.env` files.

Before the first launch, replace `HOST_AUTH_SECRET` with a long random secret and configure either `HOST_PASSWORD` or the optional companion approval service. Without one of those login methods, a new installation cannot authenticate its first host. To use the standalone password flow, open `/host` and choose USE RECOVERY PASSWORD. Use HTTPS for browser features and secure cookies.

Run checks with:

```bash
npm run check
```

## Configuration

`.env.example` contains safe placeholder values. Do not commit your real `.env` file.

Important settings:

```text
PORT=8787
ROOM_TTL_MINUTES=360
ATTACHMENT_MAX_MB=25
ROOM_ATTACHMENT_MAX_MB=100
ALLOWED_ORIGINS=https://chat.example.com
PUBLIC_ORIGIN=https://chat.example.com
HOST_AUTH_SECRET=<long random secret>
HOST_PASSWORD=<optional recovery password>
TRUST_DB=./trusted-devices.json
HOST_PUSH_FILE=./host-push.json
```

The optional companion approval integration uses the historical environment names below for compatibility:

```text
GAFBOX_URL=https://your-approval-service.example
GAFBOX_SHARED_SECRET=<shared secret>
```

You do not need the companion approval service for the core room/encryption flow.

## Direct PWA notifications

Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` using your own Web Push key pair and contact URL or `mailto:` address. With dependencies installed, generate keys with `./node_modules/.bin/web-push generate-vapid-keys`. Keep the private key in the environment. Open `/host`, authenticate, then select ENABLE GAFCHAT ALERTS and allow notifications. The service worker is included as `public/sw.js`.

Host device approval can use the optional companion service above, or the configured recovery password. Push subscriptions persist in the configured `HOST_PUSH_FILE` (default: `host-push.json` beside `server.js`); trusted people persist in the configured `TRUST_DB`. Protect both files and exclude them from source control. Stable host authentication requires a stable secret across restarts.

## Privacy model

Message text, attachment metadata, filenames, MIME types and attachment bytes are encrypted and decrypted in participant browsers.

The server still sees normal connection and routing metadata, including IP/network information, timing, room codes, display names, membership/presence events and ciphertext sizes. This is private chat software, not an anonymity system.

The room key is carried in the URL fragment. Browsers do not send URL fragments to the HTTP server, but anyone who receives the full invite link has the room key. After reading an invite, the app removes the fragment from the address bar. Keys remain in tab session storage to support reconnect and refresh; this is not protection against malicious browser extensions, compromised devices or browser session restoration.

Trusted-device credentials are stored in an HttpOnly browser cookie. The server stores only a hash of the credential in `trusted-devices.json`; optional human-readable trust labels are stored with that record.

**Burn means gone from GafChat's active server state.** It cannot erase screenshots, copied text or files that another participant has already saved.

## Trusted devices

A Host can issue a one-time trust enrollment link. Opening it binds that browser as a trusted device.

A guest with a valid invitation enters directly as Guest, without a name form, approval request or waiting screen. Saved device trust alone does not grant room access. It cannot create rooms, see the authenticated Host start card or issue new trusted-person invitations. Creating a room requires a valid Host login, enforced by both the browser controls and the API.

Clearing browser site data or moving to another browser/device requires enrollment again.

## Self-hosting notes

GafChat is designed to sit behind HTTPS in production. Set `ALLOWED_ORIGINS` and `PUBLIC_ORIGIN` to your own deployment URL. The server binds to `127.0.0.1` by default, so expose it through your HTTPS reverse proxy. The core room/encryption flow does not depend on the original author's server layout, reverse proxy, Cloudflare account or companion services.

For an installation running under a dedicated service account, set `TRUST_DB` and `HOST_PUSH_FILE` to absolute paths in a private writable state directory, such as `/var/lib/gafchat`. Create the directory first and give the service account access. Push-subscription writes use a temporary file beside `HOST_PUSH_FILE`, so the application directory can remain read-only and state may live on a separate filesystem. No secrets or runtime state from the original installation are included.

The bundled social preview image is referenced with a site-relative URL so forks do not point back to the original deployment.

## Files intentionally excluded from Git

The repository ignores local/private runtime data including:

- `.env` and `.env.*` except the safe `.env.example`
- `host-push.json` and its temporary file (private push subscriptions)
- `trusted-devices.json`
- temporary trust database files
- local backup files (`*.before-*`, `*.pre-*`)
- staging/next files
- `node_modules/`

Keep deployment credentials, host secrets, trusted-person records and infrastructure-specific configuration outside the repository.

## Hardening in v0.5.3

| Control | Default |
| --- | --- |
| Absolute room lifetime | 6 hours, even when connected |
| Idle cleanup | 6 hours without connected clients |
| Host login lifetime | 30 days; refreshed while used |
| Trusted-device lifetime | 90 days from enrollment |
| New trusted-device invitation | 24 hours, single use |
| Rooms / members per room | 16 / 16 |
| Total attachment cache plus reserved upload allowance | 256 MB |
| Simultaneous uploads | 2 globally, 1 per room |
| File / room attachment limits | At most 100 MB each; `.env.example` uses 25 MB per file |
| Room history | At most 250 envelopes and approximately 1 MB of serialized envelopes |
| WebSocket traffic | 80 incoming frames per connection per 10 seconds |
| Open WebSockets | 128 globally, 4 per member |
| Sensitive HTTP attempts | 10 per client address per 10 minutes |

Limits are configurable through `.env.example`, within the bounds enforced in `server.js`. HTTP request buckets are bounded and cleaned up. Client-address headers are trusted only from loopback reverse proxies. A proxy must overwrite untrusted client-supplied address headers; exposing the Node port directly is discouraged. All browser origins must be listed in `ALLOWED_ORIGINS` or match `PUBLIC_ORIGIN`.

Room bearer tokens travel in HTTP Authorization headers or the WebSocket subprotocol header, instead of URLs. A proxy explicitly configured to log authorization/protocol headers can still capture them. Short-lived host approval callback URLs and request-claim polling URLs still contain credentials; keep query strings out of access logs for those paths.

Notifications contain generic text rather than names or message contents. Fonts are bundled locally, with their license in `third_party/`. The legacy HEIC codec that required dynamic code evaluation is no longer loaded or served. Native HEIC conversion depends on browser support; the encrypted original remains shareable as a file. Embedded remote GIF loading is removed; clicking an external link still contacts that destination. Exit, burn and expiry clear the app's tab session entries, draft text, displayed content and media object URLs. These controls do not promise forensic erasure, remove downloads/screenshots, or protect a compromised endpoint.

Hosts can inspect trusted-device IDs with `GET /api/trust/devices` and revoke one with `POST /api/trust/revoke` using a JSON `{ "id": "..." }` body and their authenticated host cookie. Revocation prevents future use of that trusted-device credential; boot an existing room participant separately. Host logout clears that browser's cookie; it does not centrally revoke an already copied signed host token. Rotating `HOST_AUTH_SECRET` invalidates all host tokens and requires host login again.

`npm run check` runs the original checks plus real HTTP/WebSocket regressions for access control, ciphertext relay, limits, expiry, upload/burn races and device revocation. Run these under Node 22 or newer. This test suite does not replace a cryptographic audit.

### Upgrading the existing GafCloud installation

The repository's `scripts/harden-live.py` is a pinned, checksum-verified installer for reviewed v0.5.2 and v0.5.3 installations. It downloads the release, checks the baseline, stages and tests it, backs up replaced files, installs a systemd sandbox, restarts the service and verifies health. If deployment or health checks fail, it attempts to restore the previous files and systemd configuration and checks recovery. It never copies or uploads `.env`, trusted-device records or push subscriptions. A backup is not a guarantee against power loss or an uncatchable process kill.

The installer requires a running `gafchat.service`, a dedicated non-root service account, Node 22+, existing dependencies, and `TRUST_DB`/`HOST_PUSH_FILE` outside the application directory. This deployment uses localhost port 8787. It preserves environment values and trusted-device records. Any open rooms end during the restart. The systemd sandbox makes application code read-only, permits writes only to existing private state directories and private temporary storage, drops capabilities and limits the service to 1 GB of memory.

## Security notes

GafChat is an experimental encrypted chat app and has not been independently security-audited. Its shared room keys are not a ratcheting messaging protocol, and there is no independently verified identity-key mechanism. A compromised server can substitute delivered browser code or exchanged public keys. Hardening does not add forward secrecy, anonymity or protection against a compromised client. Review the code and deployment configuration before using it for high-risk communications.

Rate limiting, CSP/security headers, encrypted in-memory room data and invite-only access reduce exposure, but the security of an installation still depends on the host, reverse proxy, TLS, browser and operational practices.

## License

MIT License. See `LICENSE`.

