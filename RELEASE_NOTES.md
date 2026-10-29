# GafChat v0.5.4

Confirmed working on the original live installation on October 29, 2026.

## Guest and Host behavior

- Only authenticated Hosts can create rooms or see the Host start card.
- A full invitation opens its room directly as Guest, without a name form or approval queue.
- Missing, incomplete or invalid invitations cannot fall back to a public chat request.
- The public homepage redirects guests to the configured destination and authenticated Hosts to their dashboard.
- Leaving, burn or expiry sends guests to the configured destination.
- The original installation uses gaf.nyc as that destination; self-hosters configure GUEST_REDIRECT_URL.

## Privacy and operations

Browser encryption covers messages, file metadata and attachment contents. Server conversation state is temporary and rooms expire after a six-hour absolute lifetime by default. Notifications omit names and message contents. Browser exit cleanup clears chat session entries, drafts and displayed media. Host and device lifetimes, resource budgets, origin checks and a read-only service sandbox are documented in the README.

Environment files, credentials, trusted-device records and push subscriptions are excluded from the public source. The installer preserves private state, verifies pinned downloads, stages tests, backs up replaced files and attempts rollback on deployment failure.

## Verification

All 21 repository checks passed. Isolated browser tests covered Host login, direct guest entry, encrypted messages and attachments, generic notifications, native HEIC fallback, browser cleanup and the guest-exit redirect response. The user subsequently confirmed the live build works.

This is an experimental, unaudited encrypted chat app. It does not provide anonymity, forward secrecy, independently verified identity keys or guaranteed erasure of saved recipient copies. A compromised server can replace delivered browser code.

Runtime source: 43b5f88d2e97954d4295d6f57a7651e29ac7ae04.
Pinned installer: b34637d676b2b1d6e840cb38185912885c0aaf36.
