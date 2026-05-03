# Hermes Client for Obsidian

**Chat with Victor/Hermes directly from an Obsidian sidebar.**

This is a Hermes-native fork of [`oscarhenrycollins/obsidianclaw`](https://github.com/oscarhenrycollins/obsidianclaw). The OpenClaw WebSocket/device-pairing stack has been replaced with a desktop-first Obsidian client for the Hermes API Server.

## Current Status

Usable v1 text-chat bridge.

- Plugin id: `hermes-client`
- Backend: Hermes API Server
- Default API URL: `http://127.0.0.1:8642`
- Install path: BRAT / manual Obsidian plugin install
- Voice: planned post-v1 via Hermes STT/TTS, not required for v1

## Features

- **Hermes chat sidebar** — talk to Victor from inside the vault
- **Streaming responses** — reads Hermes SSE events from `/api/sessions/{id}/chat/stream`
- **Session list** — create and switch Obsidian-sourced Hermes sessions
- **Native Markdown rendering** — assistant replies render through Obsidian
- **Current note context** — command/button inserts active note content into the composer
- **Safe plugin boundary** — plugin reads active note only on explicit action and does not expose autonomous vault mutation tools
- **Desktop-first networking** — uses Node HTTP/HTTPS from the Obsidian desktop plugin runtime to avoid browser `EventSource`/CORS limitations

## Requirements

- Obsidian desktop
- Hermes API Server running and reachable
- If Hermes API Server has a key configured: the API Server bearer token

Hermes API Server defaults:

```text
GET  /health
GET  /api/sessions
POST /api/sessions
GET  /api/sessions/{id}/messages
POST /api/sessions/{id}/chat/stream
GET  /v1/models
```

## Install via BRAT

After a release is published with `main.js`, `manifest.json`, and `styles.css` assets:

1. In Obsidian, install and enable **BRAT**.
2. Go to **Settings → BRAT → Add Beta Plugin**.
3. Add this repository:

```text
Codename-11/obsidian-hermes-client
```

4. Enable **Hermes Client** in Community Plugins.
5. Open **Settings → Hermes Client** and configure:
   - Hermes API base URL
   - API bearer token, if configured

## Manual Development Install

```bash
git clone https://github.com/Codename-11/obsidian-hermes-client.git
cd obsidian-hermes-client
npm ci
npm run build
```

Copy these files into your vault:

```text
.obsidian/plugins/hermes-client/main.js
.obsidian/plugins/hermes-client/manifest.json
.obsidian/plugins/hermes-client/styles.css
```

Then enable **Hermes Client** in Obsidian.

## Commands

| Command | Description |
| --- | --- |
| `Hermes Client: Toggle chat sidebar` | Open/reveal the Hermes sidebar |
| `Hermes Client: Ask about current note` | Insert active note content into the composer |
| `Hermes Client: New Hermes session` | Create a new Hermes session with `source: obsidian` |
| `Hermes Client: Test Hermes connection` | Check API reachability |

## Security Model

The plugin is intentionally narrow:

- Stores only Hermes API URL and optional API Server bearer token in Obsidian plugin data.
- Does **not** store LLM provider keys.
- Reads current note only when you click/command it.
- Does not implement vault delete/rename/global replace/command execution tools.
- Hermes remains the agent runtime and owns tools, memory, STT/TTS, and provider credentials.

## Voice Roadmap

Voice support is planned after the text chat bridge is stable.

Desired post-v1 behavior:

- Record audio in the Obsidian sidebar.
- Send audio to Hermes API Server.
- Hermes performs STT using configured provider.
- Optional TTS replies using Hermes configured TTS provider.
- Plugin controls only the UX toggle; provider keys remain in Hermes.

## Development

```bash
npm ci
npm run typecheck
npm run build
```

Release assets for BRAT:

```text
main.js
manifest.json
styles.css
```

## License

MIT. Forked from ObsidianClaw by Humanity Labs.
