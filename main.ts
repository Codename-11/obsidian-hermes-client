import {
  App,
  ItemView,
  MarkdownRenderer,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import * as http from "http";
import * as https from "https";

const VIEW_TYPE_HERMES_CHAT = "hermes-chat";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8642";
const PLUGIN_SOURCE = "obsidian";
const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_ASSISTANT_LABEL = "Hermes";

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
type ConnectionState = "unknown" | "connected" | "unauthorized" | "disconnected" | "streaming";

type HermesRole = "user" | "assistant" | "system" | "tool" | string;

interface HermesClientSettings {
  apiBaseUrl: string;
  apiToken: string;
  activeSessionId: string;
  defaultSessionTitle: string;
  systemMessage: string;
  defaultModel: string;
  assistantLabel: string;
  streamResponses: boolean;
  showStreamActivity: boolean;
  enableCommandPalette: boolean;
  autoOpenSidebar: boolean;
}

interface HermesSession {
  id: string;
  title?: string | null;
  preview?: string | null;
  last_active?: number | null;
  message_count?: number | null;
  model?: string | null;
}

interface HermesMessageRecord {
  id?: number | string;
  role: HermesRole;
  content: unknown;
  timestamp?: number | null;
  tool_name?: string | null;
  finish_reason?: string | null;
}

interface ChatMessage {
  id: string;
  role: HermesRole;
  content: string;
  timestamp?: number | null;
  transient?: boolean;
  attachmentNames?: string[];
  streamState?: "thinking" | "streaming" | "complete" | "error";
  thinking?: string;
  activities?: StreamActivity[];
  runStats?: string;
}

interface HermesAttachment {
  name: string;
  contentType: string;
  content: string;
}

interface PendingAttachment extends HermesAttachment {
  size: number;
}

interface HermesCommand {
  name: string;
  description: string;
  category: string;
  aliases?: string[];
  argsHint?: string;
  subcommands?: string[];
  native?: boolean;
}

interface HermesServerMetadata {
  displayName: string;
  platform?: string;
  model?: string;
  provider?: string;
  apiMode?: string;
  commandsNative: boolean;
  capabilitiesLoaded: boolean;
}

interface StreamActivity {
  id: string;
  event: string;
  label: string;
  detail?: string;
  kind: "thinking" | "tool" | "run" | "error" | "info";
  timestamp: number;
}

interface HermesChatResponse {
  final_response?: string;
  completed?: boolean;
  partial?: boolean;
  interrupted?: boolean;
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

interface RequestOptions {
  method: HttpMethod;
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}

const DEFAULT_SETTINGS: HermesClientSettings = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  apiToken: "",
  activeSessionId: "",
  defaultSessionTitle: "Obsidian Chat",
  systemMessage: "",
  defaultModel: "",
  assistantLabel: DEFAULT_ASSISTANT_LABEL,
  streamResponses: true,
  showStreamActivity: true,
  enableCommandPalette: true,
  autoOpenSidebar: true,
};

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const maybeText = (item as { text?: unknown; content?: unknown }).text ?? (item as { content?: unknown }).content;
          return contentToString(maybeText);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim() || DEFAULT_API_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

function assistantLabel(settings: HermesClientSettings): string {
  return settings.assistantLabel.trim() || DEFAULT_ASSISTANT_LABEL;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sessionTitle(session: HermesSession): string {
  return session.title?.trim() || session.preview?.trim() || session.id.slice(0, 12);
}

function formatTime(timestamp?: number | null): string {
  if (!timestamp) return "";
  try {
    return new Date(timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

class HermesApiClient {
  constructor(private readonly settings: HermesClientSettings) {}

  async health(): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>({ method: "GET", path: "/health" });
  }

  async capabilities(): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>({ method: "GET", path: "/v1/capabilities" });
  }

  async config(): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>({ method: "GET", path: "/api/config" });
  }

  async listCommands(): Promise<HermesCommand[]> {
    const response = await this.requestJson<unknown>({ method: "GET", path: "/api/commands" });
    return normalizeCommandsPayload(response).map((command) => ({ ...command, native: true }));
  }

  async executeCommand(sessionId: string, command: string, args: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>({
      method: "POST",
      path: `/api/sessions/${encodeURIComponent(sessionId)}/commands`,
      body: { command, args },
      signal,
    });
  }

  async listModels(): Promise<string[]> {
    const response = await this.requestJson<{ data?: Array<{ id?: string }> }>({ method: "GET", path: "/v1/models" });
    return (response.data ?? []).map((model) => model.id).filter((id): id is string => Boolean(id));
  }

  async listSessions(): Promise<HermesSession[]> {
    const response = await this.requestJson<{ items?: HermesSession[] }>({
      method: "GET",
      path: `/api/sessions?source=${encodeURIComponent(PLUGIN_SOURCE)}&limit=50&offset=0`,
    });
    return response.items ?? [];
  }

  async createSession(title?: string): Promise<HermesSession> {
    const response = await this.requestJson<{ session: HermesSession }>({
      method: "POST",
      path: "/api/sessions",
      body: {
        title: title?.trim() || this.settings.defaultSessionTitle || "Obsidian Chat",
        source: PLUGIN_SOURCE,
        model: this.settings.defaultModel || null,
        system_prompt: null,
      },
    });
    return response.session;
  }

  async loadMessages(sessionId: string): Promise<ChatMessage[]> {
    const response = await this.requestJson<{ items?: HermesMessageRecord[] }>({
      method: "GET",
      path: `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
    });
    return (response.items ?? [])
      .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "tool")
      .map((message) => ({
        id: String(message.id ?? `${message.role}-${message.timestamp ?? Math.random()}`),
        role: message.role,
        content: contentToString(message.content),
        timestamp: message.timestamp,
      }))
      .filter((message) => message.content.trim().length > 0);
  }

  async streamChat(
    sessionId: string,
    message: string,
    attachments: HermesAttachment[],
    onEvent: (event: SseEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    await this.streamSse(
      {
        method: "POST",
        path: `/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
        body: this.chatBody(message, attachments),
        signal,
      },
      onEvent
    );
  }

  async chat(sessionId: string, message: string, attachments: HermesAttachment[], signal?: AbortSignal): Promise<HermesChatResponse> {
    return this.requestJson<HermesChatResponse>({
      method: "POST",
      path: `/api/sessions/${encodeURIComponent(sessionId)}/chat`,
      body: this.chatBody(message, attachments),
      signal,
    });
  }

  private chatBody(message: string, attachments: HermesAttachment[]): Record<string, unknown> {
    return {
      message,
      system_message: this.settings.systemMessage.trim() || null,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
  }

  private async requestJson<T>(options: RequestOptions): Promise<T> {
    const response = await this.rawRequest(options);
    const text = response.body.toString("utf8");
    const parsed = text ? JSON.parse(text) : {};
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(extractErrorMessage(parsed, `Hermes API returned ${response.statusCode}`));
    }
    return parsed as T;
  }

  private async streamSse(options: RequestOptions, onEvent: (event: SseEvent) => void): Promise<void> {
    const url = this.urlFor(options.path);
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const client = url.protocol === "https:" ? https : http;

    await new Promise<void>((resolve, reject) => {
      const request = client.request(
        url,
        {
          method: options.method,
          headers: this.headers(body),
        },
        (response) => {
          if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
            response.on("end", () => {
              const raw = Buffer.concat(chunks).toString("utf8");
              try {
                reject(new Error(extractErrorMessage(JSON.parse(raw), `Hermes API returned ${response.statusCode}`)));
              } catch {
                reject(new Error(raw || `Hermes API returned ${response.statusCode}`));
              }
            });
            return;
          }

          let buffer = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            buffer += chunk;
            let splitIndex = buffer.indexOf("\n\n");
            while (splitIndex >= 0) {
              const frame = buffer.slice(0, splitIndex);
              buffer = buffer.slice(splitIndex + 2);
              const parsed = parseSseFrame(frame);
              if (parsed) onEvent(parsed);
              splitIndex = buffer.indexOf("\n\n");
            }
          });
          response.on("end", () => resolve());
        }
      );

      request.on("error", reject);
      if (options.signal) {
        options.signal.addEventListener("abort", () => {
          request.destroy(new Error("Request aborted"));
          resolve();
        }, { once: true });
      }
      if (body) request.write(body);
      request.end();
    });
  }

  private async rawRequest(options: RequestOptions): Promise<{ statusCode: number; body: Buffer }> {
    const url = this.urlFor(options.path);
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const client = url.protocol === "https:" ? https : http;

    return new Promise((resolve, reject) => {
      const request = client.request(
        url,
        {
          method: options.method,
          headers: this.headers(body),
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
        }
      );
      request.on("error", reject);
      if (options.signal) {
        options.signal.addEventListener("abort", () => {
          request.destroy(new Error("Request aborted"));
          reject(new Error("Request aborted"));
        }, { once: true });
      }
      if (body) request.write(body);
      request.end();
    });
  }

  private headers(body?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "User-Agent": "obsidian-hermes-client",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body).toString();
    }
    if (this.settings.apiToken.trim()) {
      headers.Authorization = `Bearer ${this.settings.apiToken.trim()}`;
    }
    return headers;
  }

  private urlFor(path: string): URL {
    const base = normalizeBaseUrl(this.settings.apiBaseUrl);
    if (path.startsWith("http://") || path.startsWith("https://")) return new URL(path);
    return new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
  }
}

function parseSseFrame(frame: string): SseEvent | null {
  const trimmed = frame.trimEnd();
  if (!trimmed || trimmed.startsWith(":")) return null;

  let event = "message";
  const dataLines: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return { event, data: {} };
  const joined = dataLines.join("\n");
  try {
    return { event, data: JSON.parse(joined) as Record<string, unknown> };
  } catch {
    return { event, data: { raw: joined } };
  }
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const record = payload as { error?: unknown; message?: unknown };
    if (typeof record.error === "string") return record.error;
    if (record.error && typeof record.error === "object") {
      const nested = record.error as { message?: unknown };
      if (typeof nested.message === "string") return nested.message;
    }
    if (typeof record.message === "string") return record.message;
  }
  return fallback;
}


const FALLBACK_COMMANDS: HermesCommand[] = [
  { name: "help", description: "Show available commands", category: "Info" },
  { name: "commands", description: "Browse all commands and skills when supported by the gateway", category: "Info", argsHint: "[page]" },
  { name: "status", description: "Show session info", category: "Session" },
  { name: "profile", description: "Show active profile name and home directory", category: "Info" },
  { name: "usage", description: "Show token usage and rate limits for the current session", category: "Info" },
  { name: "retry", description: "Retry the last message", category: "Session" },
  { name: "undo", description: "Remove the last user/assistant exchange", category: "Session" },
  { name: "title", description: "Set a title for the current session", category: "Session", argsHint: "[name]" },
  { name: "branch", description: "Branch the current session", category: "Session", aliases: ["fork"], argsHint: "[name]" },
  { name: "compress", description: "Manually compress conversation context", category: "Session", argsHint: "[focus topic]" },
  { name: "stop", description: "Kill running background processes", category: "Session" },
  { name: "background", description: "Run a prompt in the background", category: "Session", aliases: ["bg", "btw"], argsHint: "<prompt>" },
  { name: "queue", description: "Queue a prompt for the next turn", category: "Session", aliases: ["q"], argsHint: "<prompt>" },
  { name: "steer", description: "Inject a steering message after the next tool call", category: "Session", argsHint: "<prompt>" },
  { name: "goal", description: "Manage a standing goal", category: "Session", argsHint: "[text | pause | resume | clear | status]", subcommands: ["pause", "resume", "clear", "status"] },
  { name: "model", description: "Switch model for this session", category: "Configuration", aliases: ["provider"], argsHint: "[model] [--provider name]" },
  { name: "personality", description: "Set a predefined personality", category: "Configuration", argsHint: "[name]" },
  { name: "reasoning", description: "Manage reasoning effort and display", category: "Configuration", argsHint: "[level|show|hide]", subcommands: ["none", "minimal", "low", "medium", "high", "xhigh", "show", "hide", "on", "off"] },
  { name: "fast", description: "Toggle fast mode", category: "Configuration", argsHint: "[normal|fast|status]", subcommands: ["normal", "fast", "status", "on", "off"] },
  { name: "voice", description: "Toggle voice mode", category: "Configuration", argsHint: "[on|off|tts|status]", subcommands: ["on", "off", "tts", "status"] },
  { name: "reload-mcp", description: "Reload MCP servers from config", category: "Tools & Skills", aliases: ["reload_mcp"] },
  { name: "reload-skills", description: "Re-scan skill directories", category: "Tools & Skills", aliases: ["reload_skills"] },
  { name: "curator", description: "Background skill maintenance", category: "Tools & Skills", argsHint: "[status|run|pause|resume]", subcommands: ["status", "run", "pause", "resume", "pin", "unpin", "restore"] },
  { name: "kanban", description: "Multi-profile collaboration board", category: "Tools & Skills", argsHint: "[subcommand]", subcommands: ["list", "show", "create", "assign", "comment", "complete", "block", "unblock"] },
];

function normalizeCommandsPayload(payload: unknown): HermesCommand[] {
  const raw = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? ((payload as { commands?: unknown; items?: unknown }).commands ?? (payload as { items?: unknown }).items)
      : [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): HermesCommand | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const name = asString(record.name || record.command).replace(/^\//, "");
      if (!name) return null;
      const aliases = Array.isArray(record.aliases) ? record.aliases.filter((alias): alias is string => typeof alias === "string") : [];
      const subcommands = Array.isArray(record.subcommands) ? record.subcommands.filter((sub): sub is string => typeof sub === "string") : [];
      return {
        name,
        description: asString(record.description, "Hermes command"),
        category: asString(record.category, "Commands"),
        aliases,
        argsHint: asString(record.args_hint ?? record.argsHint),
        subcommands,
        native: Boolean(record.native ?? true),
      };
    })
    .filter((command): command is HermesCommand => command !== null);
}

function commandUsage(command: HermesCommand): string {
  return `/${command.name}${command.argsHint ? ` ${command.argsHint}` : ""}`;
}

function humanizeModelName(model?: string): string {
  const clean = (model || "").trim();
  if (!clean || clean === "hermes-agent") return DEFAULT_ASSISTANT_LABEL;
  return clean
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function safeMetadataFrom(capabilities?: Record<string, unknown>, config?: Record<string, unknown>, commandsNative = false): HermesServerMetadata {
  const model = asString(capabilities?.model || config?.model);
  const provider = asString(config?.provider);
  const platform = asString(capabilities?.platform || "hermes-agent");
  return {
    displayName: humanizeModelName(model),
    platform,
    model,
    provider,
    apiMode: asString(config?.api_mode),
    commandsNative,
    capabilitiesLoaded: Boolean(capabilities),
  };
}

function activityDetail(payload: Record<string, unknown>): string {
  const preview = asString(payload.preview || payload.result_preview || payload.delta || payload.message || payload.state || payload.output || payload.result);
  if (!preview) return "";
  return preview.length > 180 ? `${preview.slice(0, 180)}...` : preview;
}

function parseSlashCommand(text: string): { command: string; args: string } | null {
  const match = text.trim().match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { command: match[1], args: (match[2] || "").trim() };
}

function commandResponseText(payload: Record<string, unknown>): string {
  const direct = asString(payload.response || payload.output || payload.message || payload.result || payload.text);
  if (direct) return direct;
  if (payload.success === false || payload.error) return `Command failed: ${asString(payload.error, "Unknown error")}`;
  return "Command completed.";
}

export default class HermesClientPlugin extends Plugin {
  settings: HermesClientSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_HERMES_CHAT, (leaf) => new HermesChatView(leaf, this));

    this.addRibbonIcon("message-square", "Hermes Client", () => this.activateView());

    this.addCommand({
      id: "toggle-chat-sidebar",
      name: "Toggle chat sidebar",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "ask-about-current-note",
      name: "Ask about current note",
      callback: () => this.askAboutCurrentNote(),
    });

    this.addCommand({
      id: "new-hermes-session",
      name: "New Hermes session",
      callback: async () => {
        await this.activateView();
        await this.getChatView()?.createSession();
      },
    });

    this.addCommand({
      id: "test-hermes-connection",
      name: "Test Hermes connection",
      callback: async () => {
        await this.activateView();
        await this.getChatView()?.testConnection(true);
      },
    });

    this.addSettingTab(new HermesSettingTab(this.app, this));

    if (this.settings.autoOpenSidebar) {
      this.app.workspace.onLayoutReady(() => {
        void this.activateView(false);
      });
    }
  }

  client(): HermesApiClient {
    return new HermesApiClient(this.settings);
  }

  getChatView(): HermesChatView | undefined {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_HERMES_CHAT)[0];
    return leaf?.view instanceof HermesChatView ? leaf.view : undefined;
  }

  async activateView(reveal = true): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_HERMES_CHAT);
    if (existing.length > 0) {
      if (reveal) await this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Could not open Hermes sidebar");
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE_HERMES_CHAT, active: true });
    if (reveal) await this.app.workspace.revealLeaf(leaf);
  }

  async askAboutCurrentNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active note to send to Hermes");
      return;
    }
    await this.activateView();
    const content = await this.app.vault.read(file);
    if (!content.trim()) {
      new Notice("Current note is empty");
      return;
    }
    const prompt = `Use the following Obsidian note as context.\n\nPath: ${file.path}\nTitle: ${file.basename}\n\n---\n${content}\n---\n\nQuestion: `;
    this.getChatView()?.prefill(prompt);
    new Notice("Note context added to Hermes input");
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.apiBaseUrl = normalizeBaseUrl(this.settings.apiBaseUrl);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class HermesChatView extends ItemView {
  private sessions: HermesSession[] = [];
  private messages: ChatMessage[] = [];
  private connectionState: ConnectionState = "unknown";
  private statusText = "Not checked";
  private inputEl?: HTMLTextAreaElement;
  private messagesEl?: HTMLElement;
  private sessionsEl?: HTMLElement;
  private statusEl?: HTMLElement;
  private abortController?: AbortController;
  private sending = false;
  private pendingAttachments: PendingAttachment[] = [];
  private attachmentsEl?: HTMLElement;
  private fileInputEl?: HTMLInputElement;
  private headerTitleEl?: HTMLElement;
  private headerSubtitleEl?: HTMLElement;
  private serverMetaEl?: HTMLElement;
  private commandPanelEl?: HTMLElement;
  private commandSearchEl?: HTMLInputElement;
  private commandListEl?: HTMLElement;
  private commandPanelVisible = false;
  private commands: HermesCommand[] = [...FALLBACK_COMMANDS];
  private commandsNativeAvailable = false;
  private serverMetadata?: HermesServerMetadata;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: HermesClientPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_HERMES_CHAT;
  }

  getDisplayText(): string {
    return "Hermes Client";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.renderShell();
    await this.bootstrap();
  }

  async onClose(): Promise<void> {
    this.abortController?.abort();
  }

  prefill(text: string): void {
    if (!this.inputEl) return;
    this.inputEl.value = text;
    this.inputEl.focus();
    this.autoResizeInput();
  }

  async testConnection(showNotice = false): Promise<void> {
    try {
      this.connectionState = "unknown";
      this.statusText = "Checking...";
      this.renderStatus();
      await this.plugin.client().health();
      this.connectionState = "connected";
      this.statusText = "Connected";
      this.renderStatus();
      if (showNotice) new Notice("Hermes API is reachable");
    } catch (error) {
      this.connectionState = "disconnected";
      this.statusText = error instanceof Error ? error.message : "Disconnected";
      this.renderStatus();
      if (showNotice) new Notice(`Hermes connection failed: ${this.statusText}`);
    }
  }

  async createSession(title?: string): Promise<void> {
    try {
      const session = await this.plugin.client().createSession(title);
      this.plugin.settings.activeSessionId = session.id;
      await this.plugin.saveSettings();
      await this.refreshSessions();
      this.messages = [];
      this.renderMessages();
      this.renderSessions();
      new Notice("Hermes session created");
    } catch (error) {
      new Notice(`Could not create Hermes session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private renderShell(): void {
    this.containerEl.empty();
    this.containerEl.addClass("hermes-client-view");

    const root = this.containerEl.createDiv({ cls: "hermes-chat-container" });

    const header = root.createDiv({ cls: "hermes-header" });
    const titleWrap = header.createDiv({ cls: "hermes-title-wrap" });
    this.headerTitleEl = titleWrap.createDiv({ text: this.displayName(), cls: "hermes-title" });
    this.headerSubtitleEl = titleWrap.createDiv({ text: "Hermes Agent API client", cls: "hermes-subtitle" });

    const headerActions = header.createDiv({ cls: "hermes-header-actions" });
    const refreshButton = headerActions.createEl("button", { cls: "clickable-icon hermes-icon-button", attr: { "aria-label": "Refresh sessions" } });
    setIcon(refreshButton, "refresh-cw");
    refreshButton.onclick = () => void this.bootstrap();
    const newButton = headerActions.createEl("button", { cls: "clickable-icon hermes-icon-button", attr: { "aria-label": "New session" } });
    setIcon(newButton, "plus");
    newButton.onclick = () => void this.createSession();

    const status = root.createDiv({ cls: "hermes-status" });
    status.createSpan({ cls: "hermes-status-dot" });
    status.createSpan({ cls: "hermes-status-spinner" });
    this.statusEl = status.createSpan({ cls: "hermes-status-text", text: this.statusText });

    this.serverMetaEl = root.createDiv({ cls: "hermes-server-meta" });
    this.renderServerMeta();

    this.sessionsEl = root.createDiv({ cls: "hermes-sessions" });
    this.messagesEl = root.createDiv({ cls: "hermes-messages" });

    const composer = root.createDiv({ cls: "hermes-composer" });
    const toolbar = composer.createDiv({ cls: "hermes-composer-toolbar" });
    const noteButton = toolbar.createEl("button", { text: "Current note", cls: "hermes-small-button" });
    noteButton.onclick = () => void this.plugin.askAboutCurrentNote();
    const commandButton = toolbar.createEl("button", { text: "Commands", cls: "hermes-small-button" });
    commandButton.onclick = () => this.toggleCommandPanel();
    const attachButton = toolbar.createEl("button", { text: "Attach image", cls: "hermes-small-button" });
    attachButton.onclick = () => this.fileInputEl?.click();
    const abortButton = toolbar.createEl("button", { text: "Stop", cls: "hermes-small-button hermes-danger-button" });
    abortButton.onclick = () => this.stopStreaming();

    this.commandPanelEl = composer.createDiv({ cls: "hermes-command-panel" });
    this.commandSearchEl = this.commandPanelEl.createEl("input", {
      type: "text",
      cls: "hermes-command-search",
      attr: { placeholder: "Search Hermes commands..." },
    });
    this.commandSearchEl.addEventListener("input", () => this.renderCommandList());
    this.commandListEl = this.commandPanelEl.createDiv({ cls: "hermes-command-list" });
    this.renderCommandPanel();

    this.fileInputEl = composer.createEl("input", {
      type: "file",
      cls: "hermes-hidden-file-input",
      attr: { accept: "image/*", multiple: "true" },
    });
    this.fileInputEl.onchange = () => void this.addFiles(this.fileInputEl?.files);
    this.attachmentsEl = composer.createDiv({ cls: "hermes-attachments" });

    composer.addEventListener("dragover", (event) => {
      event.preventDefault();
      composer.addClass("is-dragging-image");
    });
    composer.addEventListener("dragleave", () => composer.removeClass("is-dragging-image"));
    composer.addEventListener("drop", (event) => {
      event.preventDefault();
      composer.removeClass("is-dragging-image");
      void this.addFiles(event.dataTransfer?.files);
    });

    const row = composer.createDiv({ cls: "hermes-input-row" });
    this.inputEl = row.createEl("textarea", {
      cls: "hermes-input",
      attr: {
        placeholder: "Chat with Hermes... Paste or drop images to attach.",
        rows: "1",
      },
    });
    this.inputEl.addEventListener("input", () => {
      this.autoResizeInput();
      if (this.plugin.settings.enableCommandPalette && this.inputEl?.value.trimStart().startsWith("/")) {
        this.commandPanelVisible = true;
        if (this.commandSearchEl) this.commandSearchEl.value = this.inputEl.value.trimStart().slice(1);
        this.renderCommandPanel();
      }
    });
    this.inputEl.addEventListener("paste", (event: ClipboardEvent) => void this.handlePaste(event));
    this.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.sendCurrentInput();
      }
    });

    const sendButton = row.createEl("button", { cls: "hermes-send-button", attr: { "aria-label": "Send" } });
    setIcon(sendButton, "send");
    sendButton.onclick = () => void this.sendCurrentInput();

    this.renderAttachments();
  }

  private displayName(): string {
    const configured = assistantLabel(this.plugin.settings);
    if (configured !== DEFAULT_ASSISTANT_LABEL) return configured;
    return this.serverMetadata?.displayName || configured;
  }

  private updateHeader(): void {
    if (this.headerTitleEl) this.headerTitleEl.setText(this.displayName());
    if (this.headerSubtitleEl) {
      const bits = [this.serverMetadata?.provider, this.serverMetadata?.model].filter(Boolean);
      this.headerSubtitleEl.setText(bits.length > 0 ? bits.join(" · ") : "Hermes Agent API client");
    }
    this.renderServerMeta();
  }

  private renderServerMeta(): void {
    if (!this.serverMetaEl) return;
    this.serverMetaEl.empty();
    const meta = this.serverMetadata;
    if (!meta) {
      this.serverMetaEl.createSpan({ text: "Server metadata pending", cls: "hermes-meta-pill" });
      return;
    }
    this.serverMetaEl.createSpan({ text: meta.platform || "hermes-agent", cls: "hermes-meta-pill" });
    if (meta.provider) this.serverMetaEl.createSpan({ text: meta.provider, cls: "hermes-meta-pill" });
    if (meta.model) this.serverMetaEl.createSpan({ text: meta.model, cls: "hermes-meta-pill" });
    this.serverMetaEl.createSpan({
      text: meta.commandsNative ? "Native commands" : "Command hints",
      cls: `hermes-meta-pill ${meta.commandsNative ? "is-good" : "is-muted"}`,
    });
  }

  private async loadServerMetadata(): Promise<void> {
    const client = this.plugin.client();
    let capabilities: Record<string, unknown> | undefined;
    let config: Record<string, unknown> | undefined;
    try {
      capabilities = await client.capabilities();
    } catch {
      capabilities = undefined;
    }
    try {
      config = await client.config();
    } catch {
      config = undefined;
    }
    try {
      const nativeCommands = await client.listCommands();
      if (nativeCommands.length > 0) {
        this.commands = nativeCommands;
        this.commandsNativeAvailable = true;
      }
    } catch {
      this.commands = [...FALLBACK_COMMANDS];
      this.commandsNativeAvailable = false;
    }
    this.serverMetadata = safeMetadataFrom(capabilities, config, this.commandsNativeAvailable);
    this.updateHeader();
    this.renderCommandPanel();
  }

  private async bootstrap(): Promise<void> {
    await this.testConnection(false);
    await this.loadServerMetadata();
    await this.refreshSessions();
    if (!this.plugin.settings.activeSessionId && this.sessions.length > 0) {
      this.plugin.settings.activeSessionId = this.sessions[0].id;
      await this.plugin.saveSettings();
    }
    if (!this.plugin.settings.activeSessionId) {
      await this.createSession();
      return;
    }
    await this.loadActiveMessages();
  }

  private async refreshSessions(): Promise<void> {
    try {
      this.sessions = await this.plugin.client().listSessions();
      this.renderSessions();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.connectionState = message.toLowerCase().includes("api key") ? "unauthorized" : "disconnected";
      this.statusText = message;
      this.renderStatus();
      this.sessions = [];
      this.renderSessions();
    }
  }

  private async loadActiveMessages(): Promise<void> {
    const sessionId = this.plugin.settings.activeSessionId;
    if (!sessionId) return;
    try {
      this.messages = await this.plugin.client().loadMessages(sessionId);
      this.renderMessages();
    } catch (error) {
      new Notice(`Could not load Hermes messages: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private renderStatus(): void {
    const statusRoot = this.statusEl?.parentElement;
    if (statusRoot) {
      statusRoot.toggleClass("is-connected", this.connectionState === "connected");
      statusRoot.toggleClass("is-streaming", this.connectionState === "streaming");
      statusRoot.toggleClass("is-error", this.connectionState === "disconnected" || this.connectionState === "unauthorized");
    }
    if (this.statusEl) this.statusEl.setText(this.statusText);
  }

  private renderSessions(): void {
    if (!this.sessionsEl) return;
    this.sessionsEl.empty();

    if (this.sessions.length === 0) {
      const empty = this.sessionsEl.createDiv({ cls: "hermes-session-empty", text: "No Obsidian sessions yet" });
      empty.onclick = () => void this.createSession();
      return;
    }

    for (const session of this.sessions) {
      const button = this.sessionsEl.createEl("button", { cls: "hermes-session-tab" });
      button.toggleClass("is-active", session.id === this.plugin.settings.activeSessionId);
      button.createSpan({ cls: "hermes-session-title", text: sessionTitle(session) });
      const meta = button.createSpan({ cls: "hermes-session-meta" });
      const count = session.message_count ?? 0;
      meta.setText(`${count} msg${count === 1 ? "" : "s"}`);
      button.onclick = async () => {
        this.plugin.settings.activeSessionId = session.id;
        await this.plugin.saveSettings();
        this.renderSessions();
        await this.loadActiveMessages();
      };
    }
  }

  private renderMessages(): void {
    if (!this.messagesEl) return;
    this.messagesEl.empty();

    if (this.messages.length === 0) {
      const empty = this.messagesEl.createDiv({ cls: "hermes-empty" });
      empty.createDiv({ text: "No messages yet.", cls: "hermes-empty-title" });
      empty.createDiv({ text: `Ask ${this.displayName()} something, paste an image, or use Current note for context.`, cls: "hermes-empty-subtitle" });
      return;
    }

    for (const message of this.messages) {
      const item = this.messagesEl.createDiv({ cls: `hermes-message hermes-message-${message.role}` });
      const meta = item.createDiv({ cls: "hermes-message-meta" });
      meta.createSpan({ text: message.role === "user" ? "You" : message.role === "assistant" ? this.displayName() : message.role });
      const time = formatTime(message.timestamp);
      if (time) meta.createSpan({ text: time, cls: "hermes-message-time" });

      const bubble = item.createDiv({ cls: "hermes-message-bubble" });
      if (message.role === "assistant") {
        if (!message.content && (message.streamState === "thinking" || message.streamState === "streaming")) {
          const thinking = bubble.createDiv({ cls: "hermes-thinking-placeholder" });
          thinking.createSpan({ cls: "hermes-thinking-orb" });
          thinking.createSpan({ text: message.streamState === "streaming" ? "Streaming response" : `${this.displayName()} is thinking`, cls: "hermes-thinking-text" });
        } else {
          void MarkdownRenderer.render(this.app, message.content || " ", bubble, "", this);
        }
      } else {
        bubble.setText(message.content);
      }
      if (message.role === "assistant" && this.plugin.settings.showStreamActivity && (message.thinking || message.activities?.length || message.runStats)) {
        this.renderStreamActivity(item, message);
      }
      if (message.attachmentNames?.length) {
        const list = item.createDiv({ cls: "hermes-message-attachments" });
        for (const name of message.attachmentNames) {
          list.createSpan({ text: name, cls: "hermes-message-attachment" });
        }
      }
    }

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private async sendCurrentInput(): Promise<void> {
    if (!this.inputEl || this.sending) return;
    const text = this.inputEl.value.trim();
    const attachments = [...this.pendingAttachments];
    if (!text && attachments.length === 0) return;

    if (!this.plugin.settings.activeSessionId) {
      await this.createSession();
    }
    const sessionId = this.plugin.settings.activeSessionId;
    if (!sessionId) return;

    this.inputEl.value = "";
    this.pendingAttachments = [];
    this.renderAttachments();
    this.autoResizeInput();

    const parsedCommand = parseSlashCommand(text);
    if (parsedCommand && attachments.length === 0 && this.commandsNativeAvailable) {
      await this.sendNativeCommand(sessionId, parsedCommand.command, parsedCommand.args, text);
      return;
    }

    await this.sendMessage(text || "Please analyze the attached image(s).", sessionId, attachments);
  }

  private async sendNativeCommand(sessionId: string, command: string, args: string, originalText: string): Promise<void> {
    this.sending = true;
    this.abortController = new AbortController();
    const userMessage: ChatMessage = {
      id: `local-user-command-${Date.now()}`,
      role: "user",
      content: originalText,
      timestamp: Date.now() / 1000,
      transient: true,
    };
    const assistantMessage: ChatMessage = {
      id: `local-assistant-command-${Date.now()}`,
      role: "assistant",
      content: "",
      timestamp: Date.now() / 1000,
      transient: true,
      streamState: "thinking",
      activities: [],
    };
    this.messages.push(userMessage, assistantMessage);
    this.connectionState = "streaming";
    this.statusText = `Running /${command}...`;
    this.addActivity(assistantMessage, "command.started", `/${command}`, args || "Native command", "run");
    this.renderStatus();
    this.renderMessages();

    try {
      const response = await this.plugin.client().executeCommand(sessionId, command, args, this.abortController.signal);
      assistantMessage.content = commandResponseText(response);
      assistantMessage.streamState = "complete";
      this.addActivity(assistantMessage, "command.completed", `/${command} completed`, activityDetail(response), "run");
      this.connectionState = "connected";
      this.statusText = "Connected";
      await this.refreshSessions();
      this.renderMessages();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assistantMessage.streamState = "error";
      assistantMessage.content = `Command endpoint failed: ${message}\n\nFalling back to normal chat for future slash commands on this server.`;
      this.commandsNativeAvailable = false;
      this.commands = [...FALLBACK_COMMANDS];
      this.serverMetadata = this.serverMetadata ? { ...this.serverMetadata, commandsNative: false } : undefined;
      this.addActivity(assistantMessage, "command.failed", `/${command} failed`, message, "error");
      this.connectionState = "connected";
      this.statusText = "Command endpoint unavailable";
      this.updateHeader();
      this.renderCommandPanel();
      this.renderMessages();
    } finally {
      this.sending = false;
      this.abortController = undefined;
      this.renderStatus();
    }
  }

  private async sendMessage(text: string, sessionId: string, attachments: PendingAttachment[]): Promise<void> {
    this.sending = true;
    this.abortController = new AbortController();
    const userMessage: ChatMessage = {
      id: `local-user-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: Date.now() / 1000,
      transient: true,
      attachmentNames: attachments.map((attachment) => attachment.name),
    };
    const assistantMessage: ChatMessage = {
      id: `local-assistant-${Date.now()}`,
      role: "assistant",
      content: "",
      timestamp: Date.now() / 1000,
      transient: true,
      streamState: "thinking",
      thinking: "",
      activities: [],
    };
    this.messages.push(userMessage, assistantMessage);
    this.connectionState = "streaming";
    this.statusText = `${this.displayName()} is thinking...`;
    this.renderStatus();
    this.renderMessages();

    try {
      if (this.plugin.settings.streamResponses) {
        await this.plugin.client().streamChat(
          sessionId,
          text,
          attachments,
          (event) => this.handleStreamEvent(event, assistantMessage),
          this.abortController.signal
        );
      } else {
        const response = await this.plugin.client().chat(sessionId, text, attachments, this.abortController.signal);
        assistantMessage.content = response.final_response || "";
        this.renderMessages();
      }
      assistantMessage.streamState = "complete";
      this.connectionState = "connected";
      this.statusText = "Connected";
      await this.refreshSessions();
      await this.loadActiveMessages();
    } catch (error) {
      assistantMessage.streamState = "error";
      assistantMessage.content = `Error: ${error instanceof Error ? error.message : String(error)}`;
      this.connectionState = "disconnected";
      this.statusText = error instanceof Error ? error.message : "Stream failed";
      this.renderMessages();
    } finally {
      this.sending = false;
      this.abortController = undefined;
      this.renderStatus();
    }
  }

  private handleStreamEvent(event: SseEvent, assistantMessage: ChatMessage): void {
    if (!assistantMessage.activities) assistantMessage.activities = [];

    if (event.event === "session.created" || event.event === "run.started" || event.event === "message.started") {
      this.addActivity(assistantMessage, event.event, "Run started", activityDetail(event.data), "run");
      this.statusText = `${this.displayName()} is starting...`;
      this.renderStatus();
      this.renderMessages();
      return;
    }

    if (event.event === "tool.progress") {
      const delta = asString(event.data.delta);
      if (delta) assistantMessage.thinking = `${assistantMessage.thinking || ""}${delta}`;
      assistantMessage.streamState = "thinking";
      this.statusText = delta ? `Thinking: ${delta.slice(0, 80)}` : `${this.displayName()} is thinking...`;
      this.addActivity(assistantMessage, event.event, "Thinking", activityDetail(event.data), "thinking");
      this.renderStatus();
      this.renderMessages();
      return;
    }

    if (event.event === "assistant.delta") {
      assistantMessage.streamState = "streaming";
      assistantMessage.content += asString(event.data.delta);
      this.statusText = `${this.displayName()} is streaming...`;
      this.renderStatus();
      this.renderMessages();
      return;
    }

    if (event.event === "assistant.completed") {
      assistantMessage.streamState = "complete";
      assistantMessage.content = asString(event.data.content, assistantMessage.content);
      const flags = [event.data.partial ? "partial" : "", event.data.interrupted ? "interrupted" : ""].filter(Boolean).join(", ");
      this.addActivity(assistantMessage, event.event, "Assistant completed", flags, "run");
      this.renderMessages();
      return;
    }

    if (event.event === "run.completed") {
      assistantMessage.streamState = "complete";
      const apiCalls = event.data.api_calls;
      assistantMessage.runStats = typeof apiCalls === "number" ? `${apiCalls} API call${apiCalls === 1 ? "" : "s"}` : "Run completed";
      this.addActivity(assistantMessage, event.event, "Run completed", assistantMessage.runStats, "run");
      this.renderMessages();
      return;
    }

    if (event.event === "done") {
      this.statusText = "Finalized";
      this.renderStatus();
      return;
    }

    if (event.event === "tool.pending" || event.event === "tool.started" || event.event === "tool.completed" || event.event === "tool.failed") {
      const tool = asString(event.data.tool_name, "tool");
      const detail = activityDetail(event.data);
      const verb = event.event.replace("tool.", "");
      this.statusText = `${tool}: ${detail || verb}`;
      this.addActivity(assistantMessage, event.event, `${tool} ${verb}`, detail, event.event === "tool.failed" ? "error" : "tool");
      this.renderStatus();
      this.renderMessages();
      return;
    }

    if (event.event === "skill.loaded" || event.event === "memory.updated" || event.event === "artifact.created") {
      this.addActivity(assistantMessage, event.event, event.event.replace(/\./g, " "), activityDetail(event.data), "info");
      this.renderMessages();
      return;
    }

    if (event.event === "error") {
      assistantMessage.streamState = "error";
      const message = asString(event.data.message, "Hermes stream error");
      assistantMessage.content += `\n\nError: ${message}`;
      this.addActivity(assistantMessage, event.event, "Error", message, "error");
      this.renderMessages();
    }
  }

  private addActivity(message: ChatMessage, event: string, label: string, detail: string, kind: StreamActivity["kind"]): void {
    if (!message.activities) message.activities = [];
    const previous = message.activities[message.activities.length - 1];
    if (previous && previous.event === event && previous.detail === detail) return;
    message.activities.push({
      id: `${event}-${Date.now()}-${message.activities.length}`,
      event,
      label,
      detail,
      kind,
      timestamp: Date.now(),
    });
    if (message.activities.length > 12) message.activities = message.activities.slice(-12);
  }

  private renderStreamActivity(item: HTMLElement, message: ChatMessage): void {
    const panel = item.createDiv({ cls: "hermes-stream-panel" });
    if (message.thinking?.trim()) {
      const thinking = panel.createEl("details", { cls: "hermes-thinking-details" });
      thinking.open = message.streamState === "thinking";
      thinking.createEl("summary", { text: "Thinking" });
      thinking.createEl("pre", { text: message.thinking.trim().slice(-2400) });
    }
    if (message.activities?.length) {
      const list = panel.createDiv({ cls: "hermes-activity-list" });
      for (const activity of message.activities.slice(-6)) {
        const row = list.createDiv({ cls: `hermes-activity hermes-activity-${activity.kind}` });
        row.createSpan({ cls: "hermes-activity-dot" });
        row.createSpan({ text: activity.label, cls: "hermes-activity-label" });
        if (activity.detail) row.createSpan({ text: activity.detail, cls: "hermes-activity-detail" });
      }
    }
    if (message.runStats) panel.createDiv({ text: message.runStats, cls: "hermes-run-stats" });
  }

  private toggleCommandPanel(): void {
    if (!this.plugin.settings.enableCommandPalette) {
      new Notice("Hermes command palette is disabled in settings");
      return;
    }
    this.commandPanelVisible = !this.commandPanelVisible;
    this.renderCommandPanel();
    if (this.commandPanelVisible) this.commandSearchEl?.focus();
  }

  private renderCommandPanel(): void {
    if (!this.commandPanelEl) return;
    this.commandPanelEl.toggleClass("is-visible", this.commandPanelVisible && this.plugin.settings.enableCommandPalette);
    if (this.commandPanelVisible) this.renderCommandList();
  }

  private renderCommandList(): void {
    if (!this.commandListEl) return;
    this.commandListEl.empty();
    const query = (this.commandSearchEl?.value || "").trim().toLowerCase();
    const matched = this.commands
      .filter((command) => {
        const haystack = [command.name, command.description, command.category, ...(command.aliases || [])].join(" ").toLowerCase();
        return !query || haystack.includes(query);
      })
      .slice(0, 18);

    const status = this.commandListEl.createDiv({ cls: "hermes-command-mode" });
    status.setText(this.commandsNativeAvailable ? "Native command endpoint detected" : "Command endpoint not exposed yet — inserting slash text" );

    for (const command of matched) {
      const row = this.commandListEl.createEl("button", { cls: "hermes-command-row" });
      const usage = row.createDiv({ cls: "hermes-command-usage" });
      usage.createSpan({ text: commandUsage(command), cls: "hermes-command-name" });
      if (command.aliases?.length) usage.createSpan({ text: `aliases: ${command.aliases.map((alias) => `/${alias}`).join(", ")}`, cls: "hermes-command-aliases" });
      row.createDiv({ text: command.description, cls: "hermes-command-desc" });
      row.createDiv({ text: command.category, cls: "hermes-command-category" });
      row.onclick = () => this.insertCommand(command);
    }
  }

  private insertCommand(command: HermesCommand): void {
    if (!this.inputEl) return;
    const value = commandUsage(command).replace(/ <prompt>| \[.*?\]/g, " ").trimEnd();
    this.inputEl.value = `${value}${value.endsWith(" ") ? "" : " "}`;
    this.inputEl.focus();
    this.commandPanelVisible = false;
    this.renderCommandPanel();
  }

  private async handlePaste(event: ClipboardEvent): Promise<void> {
    const files = event.clipboardData?.files;
    if (!files || files.length === 0) return;
    const imageCount = Array.from(files).filter((file) => file.type.startsWith("image/")).length;
    if (imageCount === 0) return;
    event.preventDefault();
    await this.addFiles(files);
  }

  private async addFiles(files?: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    const candidates = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (candidates.length === 0) {
      new Notice("Hermes Client only supports image attachments right now");
      return;
    }

    for (const file of candidates) {
      if (this.pendingAttachments.length >= MAX_ATTACHMENTS) {
        new Notice(`Attachment limit is ${MAX_ATTACHMENTS} images`);
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        new Notice(`${file.name || "Image"} is too large (${formatBytes(file.size)}); limit is ${formatBytes(MAX_ATTACHMENT_BYTES)}`);
        continue;
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      this.pendingAttachments.push({
        name: file.name || `image-${this.pendingAttachments.length + 1}`,
        contentType: file.type || "image/png",
        content: buffer.toString("base64"),
        size: file.size,
      });
    }
    if (this.fileInputEl) this.fileInputEl.value = "";
    this.renderAttachments();
  }

  private renderAttachments(): void {
    if (!this.attachmentsEl) return;
    this.attachmentsEl.empty();
    if (this.pendingAttachments.length === 0) {
      this.attachmentsEl.createSpan({ text: "Paste/drop images or use Attach image.", cls: "hermes-attachment-hint" });
      return;
    }
    for (let index = 0; index < this.pendingAttachments.length; index += 1) {
      const attachment = this.pendingAttachments[index];
      const chip = this.attachmentsEl.createDiv({ cls: "hermes-attachment-chip" });
      chip.createSpan({ text: `${attachment.name} · ${formatBytes(attachment.size)}` });
      const removeButton = chip.createEl("button", { text: "×", cls: "hermes-attachment-remove", attr: { "aria-label": `Remove ${attachment.name}` } });
      removeButton.onclick = () => {
        this.pendingAttachments.splice(index, 1);
        this.renderAttachments();
      };
    }
  }

  private stopStreaming(): void {
    if (!this.abortController) return;
    this.abortController.abort();
    this.connectionState = "connected";
    this.statusText = "Stopped";
    this.sending = false;
    this.renderStatus();
  }

  private autoResizeInput(): void {
    // CSS owns textarea sizing; this hook remains so future auto-size behavior can
    // be added without wiring more listeners through the view.
  }
}

class HermesSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: HermesClientPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Connection").setHeading();
    containerEl.createEl("p", {
      text: "Connect Obsidian to the Hermes API Server. Provider keys stay in Hermes; this plugin only stores the local API URL and optional API Server bearer token.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Hermes API base URL")
      .setDesc("Usually http://127.0.0.1:8642 for a local Hermes API Server, or the reachable URL for your own install.")
      .addText((text) => {
        text.setPlaceholder(DEFAULT_API_BASE_URL)
          .setValue(this.plugin.settings.apiBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.apiBaseUrl = normalizeBaseUrl(value);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("API bearer token")
      .setDesc("Optional API Server key. Leave blank only if your Hermes API Server has no key configured.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Bearer token")
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            this.plugin.settings.apiToken = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Default session title")
      .setDesc("Used when creating new Hermes sessions from Obsidian.")
      .addText((text) => {
        text.setValue(this.plugin.settings.defaultSessionTitle)
          .onChange(async (value) => {
            this.plugin.settings.defaultSessionTitle = value || DEFAULT_SETTINGS.defaultSessionTitle;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Ephemeral system message")
      .setDesc("Optional instruction sent with each Obsidian chat turn. Keep it short.")
      .addTextArea((text) => {
        text.setPlaceholder("Example: Answer concisely and prefer Obsidian-friendly Markdown.")
          .setValue(this.plugin.settings.systemMessage)
          .onChange(async (value) => {
            this.plugin.settings.systemMessage = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Assistant label")
      .setDesc("Display name shown in the sidebar. Use any Hermes profile/persona name, or keep the generic default.")
      .addText((text) => {
        text.setPlaceholder(DEFAULT_ASSISTANT_LABEL)
          .setValue(this.plugin.settings.assistantLabel)
          .onChange(async (value) => {
            this.plugin.settings.assistantLabel = value || DEFAULT_ASSISTANT_LABEL;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Stream responses")
      .setDesc("Use Hermes SSE streaming by default. Turn off only for troubleshooting older API Server installs.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.streamResponses)
          .onChange(async (value) => {
            this.plugin.settings.streamResponses = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Show streaming activity")
      .setDesc("Show live thinking/progress/tool events from the Hermes SSE stream under the response.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showStreamActivity)
          .onChange(async (value) => {
            this.plugin.settings.showStreamActivity = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Command palette")
      .setDesc("Show Hermes command hints in the composer. Uses native /api/commands metadata when the server exposes it; otherwise falls back to built-in hints.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enableCommandPalette)
          .onChange(async (value) => {
            this.plugin.settings.enableCommandPalette = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Auto-open sidebar")
      .setDesc("Open Hermes Client when Obsidian starts.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoOpenSidebar)
          .onChange(async (value) => {
            this.plugin.settings.autoOpenSidebar = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Connection")
      .setDesc("Checks /health and session endpoints without exposing the token.")
      .addButton((button) => {
        button.setButtonText("Test connection")
          .setCta()
          .onClick(async () => {
            await this.plugin.activateView();
            await this.plugin.getChatView()?.testConnection(true);
          });
      });
  }
}
