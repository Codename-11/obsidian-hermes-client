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
}

interface HermesAttachment {
  name: string;
  contentType: string;
  content: string;
}

interface PendingAttachment extends HermesAttachment {
  size: number;
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
    titleWrap.createDiv({ text: assistantLabel(this.plugin.settings), cls: "hermes-title" });
    titleWrap.createDiv({ text: "Hermes Agent API client", cls: "hermes-subtitle" });

    const headerActions = header.createDiv({ cls: "hermes-header-actions" });
    const refreshButton = headerActions.createEl("button", { cls: "clickable-icon hermes-icon-button", attr: { "aria-label": "Refresh sessions" } });
    setIcon(refreshButton, "refresh-cw");
    refreshButton.onclick = () => void this.bootstrap();
    const newButton = headerActions.createEl("button", { cls: "clickable-icon hermes-icon-button", attr: { "aria-label": "New session" } });
    setIcon(newButton, "plus");
    newButton.onclick = () => void this.createSession();

    const status = root.createDiv({ cls: "hermes-status" });
    status.createSpan({ cls: "hermes-status-dot" });
    this.statusEl = status.createSpan({ cls: "hermes-status-text", text: this.statusText });

    this.sessionsEl = root.createDiv({ cls: "hermes-sessions" });
    this.messagesEl = root.createDiv({ cls: "hermes-messages" });

    const composer = root.createDiv({ cls: "hermes-composer" });
    const toolbar = composer.createDiv({ cls: "hermes-composer-toolbar" });
    const noteButton = toolbar.createEl("button", { text: "Current note", cls: "hermes-small-button" });
    noteButton.onclick = () => void this.plugin.askAboutCurrentNote();
    const attachButton = toolbar.createEl("button", { text: "Attach image", cls: "hermes-small-button" });
    attachButton.onclick = () => this.fileInputEl?.click();
    const abortButton = toolbar.createEl("button", { text: "Stop", cls: "hermes-small-button hermes-danger-button" });
    abortButton.onclick = () => this.stopStreaming();

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
    this.inputEl.addEventListener("input", () => this.autoResizeInput());
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

  private async bootstrap(): Promise<void> {
    await this.testConnection(false);
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
      empty.createDiv({ text: `Ask ${assistantLabel(this.plugin.settings)} something, paste an image, or use Current note for context.`, cls: "hermes-empty-subtitle" });
      return;
    }

    for (const message of this.messages) {
      const item = this.messagesEl.createDiv({ cls: `hermes-message hermes-message-${message.role}` });
      const meta = item.createDiv({ cls: "hermes-message-meta" });
      meta.createSpan({ text: message.role === "user" ? "You" : message.role === "assistant" ? assistantLabel(this.plugin.settings) : message.role });
      const time = formatTime(message.timestamp);
      if (time) meta.createSpan({ text: time, cls: "hermes-message-time" });

      const bubble = item.createDiv({ cls: "hermes-message-bubble" });
      if (message.role === "assistant") {
        void MarkdownRenderer.render(this.app, message.content || " ", bubble, "", this);
      } else {
        bubble.setText(message.content);
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
    await this.sendMessage(text || "Please analyze the attached image(s).", sessionId, attachments);
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
    };
    this.messages.push(userMessage, assistantMessage);
    this.connectionState = "streaming";
    this.statusText = `${assistantLabel(this.plugin.settings)} is thinking...`;
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
      this.connectionState = "connected";
      this.statusText = "Connected";
      await this.refreshSessions();
      await this.loadActiveMessages();
    } catch (error) {
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
    if (event.event === "assistant.delta") {
      assistantMessage.content += asString(event.data.delta);
      this.renderMessages();
      return;
    }
    if (event.event === "assistant.completed") {
      assistantMessage.content = asString(event.data.content, assistantMessage.content);
      this.renderMessages();
      return;
    }
    if (event.event === "tool.started" || event.event === "tool.completed" || event.event === "tool.failed") {
      const tool = asString(event.data.tool_name, "tool");
      const preview = asString(event.data.preview || event.data.result_preview, "");
      this.statusText = `${tool}: ${preview || event.event.replace("tool.", "")}`;
      this.renderStatus();
      return;
    }
    if (event.event === "error") {
      assistantMessage.content += `\n\nError: ${asString(event.data.message, "Hermes stream error")}`;
      this.renderMessages();
    }
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
