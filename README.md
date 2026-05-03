# Hermes Client for Obsidian

**Chat with any reachable Hermes Agent API Server from an Obsidian sidebar.**

Hermes Client is a desktop Obsidian plugin for [Hermes Agent](https://hermes-agent.nousresearch.com/docs). It is a Hermes-native fork of [`oscarhenrycollins/obsidianclaw`](https://github.com/oscarhenrycollins/obsidianclaw): the OpenClaw WebSocket/device-pairing stack has been replaced with Hermes HTTP and Server-Sent Events APIs.

The plugin is intentionally generic. It does not assume a specific profile name, operator, vault, hostname, or deployment. Point it at your Hermes API Server, add a bearer token if your server requires one, and chat.

## Current Status

Usable `0.1.2` Hermes-native text, image, and Relay-style voice chat bridge with event-aware streaming UI.

- Plugin id: `hermes-client`
- Backend: Hermes Agent API Server
- Default API URL: `http://127.0.0.1:8642` — common local Hermes API Server default; change it for your install
- Install path: BRAT or manual Obsidian plugin install
- Streaming: enabled by default via Hermes SSE
- Stream activity: animated thinking/streaming state, tool progress, skill/memory/artifact activity, and run completion metadata when emitted by Hermes
- Commands: command palette uses `/api/commands` metadata and `/api/sessions/{id}/commands` execution when exposed; otherwise it falls back to safe slash-command insertion hints
- Server metadata: displays safe model/provider/platform hints when exposed by Hermes
- Image input: paste, drag/drop, or file picker image attachments
- Voice: Hermes-native MediaRecorder dictation, API Server STT, sentence-chunked TTS playback, barge-in stop path, and MorphingSphere-style voice state UI

## Features

- **Hermes chat sidebar** — talk to your configured Hermes agent/profile from inside Obsidian.
- **Streaming by default** — reads Hermes SSE events from `POST /api/sessions/{id}/chat/stream` with animated thinking/streaming indicators.
- **Event-aware activity** — surfaces `tool.progress`, `tool.pending`, `tool.started`, `tool.completed`, `tool.failed`, `skill.loaded`, `memory.updated`, `artifact.created`, `run.completed`, and `done` events when emitted.
- **Non-stream fallback** — optional setting uses `POST /api/sessions/{id}/chat` for older/troubleshooting installs.
- **Image attachments** — paste screenshots, drag/drop images, or use **Attach image**. Images are sent as Hermes API `attachments` with `name`, `contentType`, and base64 `content`.
- **Relay-style voice mode** — record with MediaRecorder, upload audio to Hermes STT, send the transcript into the active session, stream assistant text, synthesize sentence chunks through Hermes TTS, and play the queue immediately.
- **Barge-in path** — starting a new dictation stops current TTS playback and aborts the active stream if one is running.
- **MorphingSphere voice UI** — listening/thinking/speaking/error state with mic/output analyser-driven amplitude.
- **Session list** — create and switch Obsidian-sourced Hermes sessions.
- **Hermes command palette** — searchable command hints; dynamically upgrades to native command metadata/execution if the API Server exposes `/api/commands` and `/api/sessions/{id}/commands`.
- **Safe metadata header** — shows non-secret platform/model/provider/capability hints when available.
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
GET  /v1/capabilities        # optional metadata probe
GET  /api/sessions
POST /api/sessions
GET  /api/sessions/{id}/messages
POST /api/sessions/{id}/chat
POST /api/sessions/{id}/chat/stream
GET  /api/config             # optional safe model/provider metadata probe
GET  /api/commands           # optional native command metadata probe
POST /api/sessions/{id}/commands # optional native command execution
GET  /api/audio/capabilities # optional voice capability probe
POST /api/audio/transcriptions # Hermes STT audio upload
POST /api/audio/speech       # Hermes TTS audio/mpeg response
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
   - **Show streaming activity** — on by default.
   - **Command palette** — on by default; uses native Hermes command endpoints only when exposed.

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

### Obsidian commands

| Command | Description |
| --- | --- |
| `Hermes Client: Toggle chat sidebar` | Open/reveal the Hermes sidebar |
| `Hermes Client: Ask about current note` | Insert active note content into the composer |
| `Hermes Client: New Hermes session` | Create a new Hermes session with `source: obsidian` |
| `Hermes Client: Test Hermes connection` | Check API reachability |

### Hermes slash commands

The sidebar has a **Commands** button and opens command hints automatically when the composer starts with `/`. If your Hermes API Server exposes command endpoints, Hermes Client loads native command metadata and sends slash commands through `/api/sessions/{id}/commands`. If those endpoints are absent, it clearly labels the mode as command hints and only inserts slash text into the composer. That keeps older/generic Hermes installs usable without pretending the server supports native command execution.

## Security Model

The plugin is intentionally narrow:

- Stores only Hermes API URL, optional API Server bearer token, session id, and UI preferences in Obsidian plugin data.
- Does **not** store LLM provider keys, STT/TTS provider keys, tool credentials, or Hermes runtime configuration.
- Sends typed chat text and explicitly attached images.
- Reads current note only when you click/command it.
- Does not automatically index, upload, or send the whole vault.
- Does not implement vault delete/rename/global replace tools.
- Command palette execution is limited to Hermes API Server command endpoints when explicitly exposed by the server; otherwise commands are just inserted text hints.
- Hermes remains the agent runtime and owns tools, memory, voice providers, model/provider credentials, and external integrations.

See [`SECURITY.md`](SECURITY.md) for deployment guidance.

## Limits

- Desktop-only because it uses Obsidian's Node plugin runtime.
- Image attachments are capped client-side at 6 images and 10 MB each.
- Non-image file attachments are not implemented yet.
- Model/provider quality for images depends on the Hermes backend/profile/model you run.
- No direct note-writing actions yet; future write actions should be explicit and user-targeted.

## Voice Mode

Voice support is Hermes-native: provider keys and STT/TTS configuration stay in Hermes, while this plugin only captures audio and plays returned audio.

Current v0.1.2 behavior:

- **Dictate** records a single utterance with `MediaRecorder` and uploads it as multipart audio to `POST /api/audio/transcriptions`.
- The returned transcript is sent to the active Hermes session using the same chat/SSE path as typed messages.
- **Replies on** enables realtime-feeling TTS: assistant SSE deltas are buffered at sentence boundaries, posted to `POST /api/audio/speech`, and played as an audio queue before the full response is complete.
- Starting dictation while speech/streaming is active stops playback and aborts the active request as a first-pass barge-in path.
- Browser speech recognition is intentionally not the primary path; Hermes owns provider selection.

Later true-realtime work can add VAD chunking, partial transcripts, websocket audio streams, and provider-native duplex adapters behind this same client abstraction.

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
