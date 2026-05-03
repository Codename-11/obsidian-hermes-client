# Security

Hermes Client connects Obsidian desktop to a Hermes API Server. This document describes the v1 security boundary.

## Assumptions

- You control the Obsidian vault and the Hermes API Server.
- Hermes API Server is local or reachable over a trusted private network.
- If the API Server is configured with a key, the plugin stores only that API Server bearer token.
- LLM provider keys, STT/TTS provider keys, tool credentials, memory, and runtime configuration stay in Hermes.

## Data Stored by the Plugin

The plugin stores Obsidian plugin settings only:

- Hermes API base URL
- Optional API Server bearer token
- Active Hermes session id
- Default session title
- Optional ephemeral system message
- UI preferences

Do not put provider API keys in this plugin. Provider credentials belong in Hermes.

## Data Sent to Hermes

The plugin sends only explicit user actions:

- Chat messages typed in the sidebar
- Active note content when using **Ask about current note** / **Current note**
- Optional ephemeral system message configured in plugin settings

The plugin does not automatically send the whole vault.

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

- Keep Hermes API Server bound to localhost or a private network.
- Use an API Server bearer token if the endpoint is reachable beyond localhost.
- Prefer HTTPS or a trusted tunnel/VPN for remote access.

## Voice Roadmap

Voice support is planned post-v1. When added, audio should be sent to Hermes API Server and processed by Hermes-configured STT/TTS providers. The plugin should not store STT/TTS provider keys.
