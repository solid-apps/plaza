# plaza

Group chat on the open web.

A Slack-shaped, Solid-native chat app. Each pod hosts its own plaza (a group chat anyone with access can read & post to). No servers in the middle — every message is a JSON-LD resource on a Solid pod.

**Live**: [solid-apps.github.io/plaza](https://solid-apps.github.io/plaza/)

## Why

Slack is a workspace. Plaza is a town square. The chat that meets you in the plaza:

- **Decentralised** — your messages live on your pod. No company hosts the conversation.
- **Cross-pod** — alice at `acme.solid` and bob at `globex.solid` in the same channel, no bridge bot, no Slack Connect, no email export. Two pods, one container, both speaking Solid.
- **Browsable** — every message is a file. Point a Solid file manager at `/public/plaza/` and you can scroll your chat history like a folder. (See [`solid-apps/explorer`](https://github.com/solid-apps/explorer).)
- **Own your messages** — edit or delete forever, they're yours.

## Status

Phase 1 (PoC). Single channel per pod at `/public/plaza/`. Send + receive, real-time via JSS `/.notifications` WebSocket, light palette anchored on Solid purple.

## Roadmap

| Phase | Scope |
|---|---|
| **1 — PoC** | Single channel per pod, JSON-LD message resources, real-time, xlogin auth, send + receive |
| 2 | Workspaces — multiple channels per pod with shared membership ACL |
| 3 | Reactions (`schema:ReactAction`) |
| 4 | Cross-pod channels — ACL with WebIDs from multiple pods. The demo moment. |
| 5 | Presence + typing via Nostr ephemeral (hybrid) |
| 6 | Mentions + per-user notification |
| 7 | Threads (sub-container per message) |
| 8 | Search (SPARQL once available; regex client-side until then) |

## Data shape

Each message is one resource at `/public/plaza/<epoch>-<rand>.jsonld`:

```json
{
  "@context": { "schema": "https://schema.org/" },
  "@id": "",
  "@type": "schema:Message",
  "schema:text": "Hello plaza",
  "schema:dateCreated": "2026-05-19T10:23:45.000Z",
  "schema:sender": { "@id": "https://alice.pod/profile/card#me" }
}
```

Container-of-messages, not single-file. Each post is an immutable resource; edits would be a new resource referencing the original (Phase 2+).

## URL params

- `?pod=https://alice.pod` — open the plaza at this pod instead of the default

## Local dev

```bash
git clone https://github.com/solid-apps/plaza.git
cd plaza
python3 -m http.server 8002
# open http://localhost:8002/?pod=http://localhost:4443
```

## License

AGPL-3.0-only
