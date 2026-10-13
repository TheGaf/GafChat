# GafChat

Private, temporary, self-hosted encrypted chat.

Current snapshot: **v0.5.2**.

## What it does

- Invite-only rooms with short room codes and shareable `/r/CODE` links.
- Browser-side AES-GCM encryption for message text, attachment metadata and attachment bytes.
- The room key travels in the URL fragment, so it is not sent to the server as part of the HTTP request.
- Photos, video and files render or download after decrypting in the recipient browser.
- HEIC/HEIF photos can be converted in-browser before encryption.
- The example configuration limits attachments to 25 MB per file and 100 MB total attachment cache per room.
- Rooms, message history and encrypted attachments live in server memory and disappear on burn, idle expiry or server restart.
- Room owners can approve, deny and boot participants and can burn the room.
- Trusted devices can create rooms and join without repeated approval while remaining separate from the system Host role.
- Social preview metadata and a 1200×630 share card are included.
- Direct PWA push notifications alert the host to CHAT WITH GAF requests.
- Host approval can create a room and optionally save the requester as trusted.
- Secure invite tokens, typing indicators, encrypted emoji reactions and clickable links.
- Installed PWA opens `/host`; host burn returns there, and guests can leave.
- Mobile sizing and room controls match the locked live v0.5.2 snapshot.

## Quick start

```bash
npm install
cp .env.example .env
# Edit .env for your deployment, then load it into the shell:
set -a
. ./.env
set +a
npm start
```

GafChat reads configuration from process environment variables; it does not automatically parse `.env` files.

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
ROOM_ATTACHMENT_MAX_MB=25
ALLOWED_ORIGINS=https://chat.example.com
PUBLIC_ORIGIN=https://chat.example.com
HOST_AUTH_SECRET=<long random secret>
HOST_PASSWORD=<optional recovery password>
TRUST_DB=./trusted-devices.json
```

The optional companion approval integration uses the historical environment names below for compatibility:

```text
GAFBOX_URL=https://your-approval-service.example
GAFBOX_SHARED_SECRET=<shared secret>
```

You do not need the companion approval service for the core room/encryption flow.

## Direct PWA notifications

Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` using your own Web Push key pair and contact URL or `mailto:` address. With dependencies installed, generate keys with `./node_modules/.bin/web-push generate-vapid-keys`. Keep the private key in the environment. Open `/host`, authenticate, then select ENABLE GAFCHAT ALERTS and allow notifications. The service worker is included as `public/sw.js`.

Host device approval can use the optional companion service above, or the configured recovery password. Push subscriptions persist in `host-push.json`; trusted people persist in the configured `TRUST_DB`. Protect both files and exclude them from source control. Stable host authentication requires a stable secret across restarts.

## Privacy model

Message text, attachment metadata, filenames, MIME types and attachment bytes are encrypted and decrypted in participant browsers.

The server still sees normal connection and routing metadata, including IP/network information, timing, room codes, display names, membership/presence events and ciphertext sizes. This is private chat software, not an anonymity system.

The room key is carried in the URL fragment. Browsers do not send URL fragments to the HTTP server, but anyone who receives the full invite link has the room key.

Trusted-device credentials are stored in an HttpOnly browser cookie. The server stores only a hash of the credential in `trusted-devices.json`; optional human-readable trust labels are stored with that record.

**Burn means gone from GafChat's active server state.** It cannot erase screenshots, copied text or files that another participant has already saved.

## Trusted devices

A Host can issue a one-time trust enrollment link. Opening it binds that browser as a trusted device.

A trusted device can create its own rooms and join rooms without waiting for owner approval. It does **not** become the system Host and cannot issue new trusted-person invitations.

Clearing browser site data or moving to another browser/device requires enrollment again.

## Self-hosting notes

GafChat is designed to sit behind HTTPS in production. Set `ALLOWED_ORIGINS` and `PUBLIC_ORIGIN` to your own deployment URL. The core room/encryption flow does not depend on the original author's server layout, reverse proxy, Cloudflare account or companion services.

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

## Security notes

GafChat is intentionally small and has not been presented as a formally audited cryptographic product. Review the code and deployment configuration before using it for high-risk communications.

Rate limiting, CSP/security headers, encrypted in-memory room data and invite-only access reduce exposure, but the security of an installation still depends on the host, reverse proxy, TLS, browser and operational practices.

## License

MIT License. See `LICENSE`.
