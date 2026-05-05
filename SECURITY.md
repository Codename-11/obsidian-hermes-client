# Security

Hermes Client connects Obsidian desktop to a Hermes Agent API Server. This document describes the v1 security boundary for any self-hosted or local Hermes install.

## Assumptions

- You control the Obsidian vault and the Hermes API Server you configure.
- Hermes API Server is local, on a trusted private network, or exposed through infrastructure you trust.
- If the API Server is configured with auth, the plugin stores only that API Server bearer token.
- LLM provider keys, STT/TTS provider keys, tool credentials, memory, and runtime configuration stay in Hermes.

## Data Stored by the Plugin

The plugin stores Obsidian plugin settings only:

- Hermes API base URL
- Optional API Server bearer token
- Active Hermes session id
- Default session title
- Optional ephemeral system message
- Assistant display label
- Streaming preference
- UI preferences
- Voice backend preference
- Optional Hermes-Relay voice URL
- Optional local-network development toggle for insecure Relay voice HTTP

Do not put provider API keys in this plugin. Provider credentials belong in Hermes.

## Data Sent to Hermes

The plugin sends only explicit user actions:

- Chat messages typed in the sidebar
- Images pasted, dropped, or selected with **Attach image**
- Active note content when using **Ask about current note** / **Current note**, sent as hidden one-turn context rather than visible chat text
- Safe Obsidian harness context when enabled, such as source, vault name, active note path/title, and current `obsidian://open` route
- Optional ephemeral system message configured in plugin settings
- Voice audio recorded after clicking **Dictate**
- TTS sentence chunks when **Replies on** is enabled

Image attachments are sent to Hermes as request-body `attachments` entries with:

```json
{
  "name": "screenshot.png",
  "contentType": "image/png",
  "content": "<base64>"
}
```

The plugin does not automatically send the whole vault or scan notes in the background.

## Vault Mutation Boundary

Hermes Client v1 does not implement direct vault mutation tools:

- no delete
- no rename
- no global search/replace
- no command execution inside Obsidian
- no autonomous note writes

Future explicit write buttons may be added, but they should require a user click and a visible target.

## Transport

The plugin is desktop-only and uses Node HTTP/HTTPS from the Obsidian plugin runtime. This avoids browser `EventSource` limitations for authenticated POST-based SSE streams.

Recommended deployment:

- Keep Hermes API Server bound to localhost or a private network when possible.
- Use an API Server bearer token if the endpoint is reachable beyond localhost.
- Prefer HTTPS or a trusted tunnel/VPN for remote access.
- Treat the bearer token like a password: do not commit it, paste it into screenshots, or share plugin data files.

## Voice Security

Voice support is implemented through Hermes-owned STT/TTS providers. Hermes Client records audio locally only after an explicit user action, uploads it to the selected voice backend, and plays returned audio. The plugin does not store STT/TTS provider keys.

Supported voice backends:

- **Hermes API** — uses `/api/audio/capabilities`, `/api/audio/transcriptions`, and `/api/audio/speech` on the Hermes API Server.
- **Hermes-Relay** — uses `/voice/config`, `/voice/transcribe`, and `/voice/synthesize` on [Hermes-Relay](https://github.com/Codename-11/hermes-relay).

For Hermes-Relay voice, Hermes Client follows the Relay voice auth boundary: the Hermes API bearer token may be sent only to `/voice/config`, `/voice/transcribe`, and `/voice/synthesize`. Relay pairing/session-token auth remains required for terminal, bridge, TUI, media, sessions, clipboard, profile writes, and Android control routes. Non-loopback API-bearer Relay voice should use HTTPS; the insecure local-network toggle is for temporary development only.
