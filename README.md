# Hermes Client for Obsidian

**Chat with any reachable Hermes Agent API Server from an Obsidian sidebar.**

Hermes Client is a desktop Obsidian plugin for [Hermes Agent](https://hermes-agent.nousresearch.com/docs). It is a Hermes-native fork of [`oscarhenrycollins/obsidianclaw`](https://github.com/oscarhenrycollins/obsidianclaw): the OpenClaw WebSocket/device-pairing stack has been replaced with Hermes HTTP and Server-Sent Events APIs.

The plugin is intentionally generic. It does not assume a specific profile name, operator, vault, hostname, or deployment. Point it at your Hermes API Server, add a bearer token if your server requires one, and chat.

## Current Status

Usable `0.1.0` text + image chat bridge.

- Plugin id: `hermes-client`
- Backend: Hermes Agent API Server
- Default API URL: `http://127.0.0.1:8642` — common local Hermes API Server default; change it for your install
- Install path: BRAT or manual Obsidian plugin install
- Streaming: enabled by default via Hermes SSE
- Image input: paste, drag/drop, or file picker image attachments
- Voice: planned post-v1 via Hermes API Server STT/TTS endpoints, not implemented inside the plugin

## Features

- **Hermes chat sidebar** — talk to your configured Hermes agent/profile from inside Obsidian.
- **Streaming by default** — reads Hermes SSE events from `POST /api/sessions/{id}/chat/stream`.
- **Non-stream fallback** — optional setting uses `POST /api/sessions/{id}/chat` for older/troubleshooting installs.
- **Image attachments** — paste screenshots, drag/drop images, or use **Attach image**. Images are sent as Hermes API `attachments` with `name`, `contentType`, and base64 `content`.
- **Session list** — create and switch Obsidian-sourced Hermes sessions.
- **Native Markdown rendering** — assistant replies render through Obsidian.
- **Current note context** — command/button inserts active note content into the composer only when requested.
- **Configurable assistant label** — display `Hermes`, `Victor`, `Mizu`, or any local profile/persona name without hardcoding it into the plugin.
- **Safe plugin boundary** — no autonomous vault mutation tools in v1.
- **Desktop-first networking** — uses Node HTTP/HTTPS from the Obsidian desktop plugin runtime to support authenticated POST-based SSE without browser CORS/EventSource limitations.

## Requirements

- Obsidian desktop.
- A reachable Hermes Agent API Server.
- Optional API Server bearer token if your Hermes API Server is configured with auth.

Hermes Client expects the documented Hermes API Server surface:

```text
GET  /health
GET  /v1/models
GET  /api/sessions
POST /api/sessions
GET  /api/sessions/{id}/messages
POST /api/sessions/{id}/chat
POST /api/sessions/{id}/chat/stream
```

Chat request bodies use:

```json
{
  "message": "Describe this image.",
  "system_message": null,
  "attachments": [
    {
      "name": "screenshot.png",
      "contentType": "image/png",
      "content": "<base64>"
    }
  ]
}
```

The `attachments` field is omitted when no images are attached.

## Enable Hermes API Server

Follow the upstream Hermes Agent docs for your install: <https://hermes-agent.nousresearch.com/docs>

A typical local setup exposes the API Server at:

```text
http://127.0.0.1:8642
```

If your server is remote, tunneled, reverse-proxied, or containerized, use the URL that Obsidian desktop can reach from the machine running Obsidian.

If the API Server has auth enabled, paste only the API Server bearer token into Hermes Client settings. Do **not** paste LLM provider API keys into this plugin.

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
   - **Hermes API base URL** — for example `http://127.0.0.1:8642`.
   - **API bearer token** — optional, only if configured on your Hermes API Server.
   - **Assistant label** — UI-only display label; defaults to `Hermes`.
   - **Stream responses** — on by default.

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

- Stores only Hermes API URL, optional API Server bearer token, session id, and UI preferences in Obsidian plugin data.
- Does **not** store LLM provider keys, STT/TTS provider keys, tool credentials, or Hermes runtime configuration.
- Sends typed chat text and explicitly attached images.
- Reads current note only when you click/command it.
- Does not automatically index, upload, or send the whole vault.
- Does not implement vault delete/rename/global replace/command execution tools.
- Hermes remains the agent runtime and owns tools, memory, voice providers, model/provider credentials, and external integrations.

See [`SECURITY.md`](SECURITY.md) for deployment guidance.

## Limits

- Desktop-only because it uses Obsidian's Node plugin runtime.
- Image attachments are capped client-side at 6 images and 10 MB each.
- Non-image file attachments are not implemented yet.
- Model/provider quality for images depends on the Hermes backend/profile/model you run.
- No direct note-writing actions yet; future write actions should be explicit and user-targeted.

## Voice Roadmap

Voice support belongs behind Hermes API Server, not inside this plugin.

Desired post-v1 behavior:

- Record audio in the Obsidian sidebar.
- Send audio to Hermes API Server.
- Hermes performs STT using its configured provider.
- Optional TTS replies using Hermes configured TTS provider.
- Plugin controls only UX; provider keys remain in Hermes.

## Development

```bash
npm ci
npm run typecheck
npm run lint
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
