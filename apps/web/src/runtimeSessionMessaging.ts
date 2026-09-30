import { componentMessagePayload, componentMessageTypeError } from "./componentMessageModel";

export interface RuntimeSessionIdentity { sessionId: string; projectId: string; publishedAt: string }
export interface GatewaySessionMessage extends RuntimeSessionIdentity {
  messageId: string; messageType: string; payload: Readonly<Record<string, unknown>>; scope: "session"; timestamp: string;
}
interface Stream {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
}
export interface RuntimeSessionTransport {
  isCurrent?(): boolean;
  register(signal: AbortSignal): Promise<RuntimeSessionIdentity>;
  open(identity: RuntimeSessionIdentity): Stream;
  unregister(identity: RuntimeSessionIdentity): Promise<unknown>;
  tags(values: unknown[]): void;
  message(value: GatewaySessionMessage): void;
  status(connected: boolean, error?: string): void;
  schedule?(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  cancel?(timer: ReturnType<typeof setTimeout>): void;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function runtimeSessionIdentity(value: unknown, projectId: string, publishedAt: string): RuntimeSessionIdentity {
  if (!object(value) || typeof value.sessionId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value.sessionId) || value.projectId !== projectId || value.publishedAt !== publishedAt)
    throw new Error("The gateway returned a session for a different project or publication.");
  return { sessionId: value.sessionId, projectId, publishedAt };
}
export function gatewaySessionMessage(value: unknown, identity: RuntimeSessionIdentity): GatewaySessionMessage {
  if (!object(value) || value.sessionId !== identity.sessionId || value.projectId !== identity.projectId || value.publishedAt !== identity.publishedAt || value.scope !== "session")
    throw new Error("A gateway message does not belong to this operator session.");
  if (typeof value.messageId !== "string" || !value.messageId || value.messageId.length > 128 || /\p{Cc}/u.test(value.messageId) || componentMessageTypeError(value.messageType) || typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp)))
    throw new Error("The gateway returned an invalid session message.");
  return { ...identity, messageId: value.messageId, messageType: value.messageType as string, scope: "session", timestamp: value.timestamp, payload: componentMessagePayload(value.payload) };
}

/** A disconnected stream never resumes an old queue. Reconnect obtains a new server identity. */
export class RuntimeSessionConnection {
  private closed = true;
  private generation = 0;
  private attempts = 0;
  private controller?: AbortController;
  private stream?: Stream;
  private identity?: RuntimeSessionIdentity;
  private retry?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  constructor(private readonly projectId: string, private readonly publishedAt: string, private readonly transport: RuntimeSessionTransport) {}
  start() { if (!this.closed) return; this.closed = false; void this.connect(); }
  stop() {
    if (this.closed) return;
    this.closed = true; ++this.generation;
    if (this.retry !== undefined) (this.transport.cancel ?? clearTimeout)(this.retry);
    this.retry = undefined;
    this.retire();
  }
  private retire() {
    if (this.deadline !== undefined) (this.transport.cancel ?? clearTimeout)(this.deadline);
    this.deadline = undefined;
    this.controller?.abort(); this.controller = undefined;
    this.stream?.close(); this.stream = undefined;
    const identity = this.identity; this.identity = undefined;
    if (identity) void this.transport.unregister(identity).catch(() => {});
  }
  private async connect() {
    if (this.closed || this.transport.isCurrent?.() === false) return;
    const generation = ++this.generation;
    const current = () => !this.closed && generation === this.generation && this.transport.isCurrent?.() !== false;
    const controller = new AbortController(); this.controller = controller;
    const fail = (error?: unknown) => {
      if (!current()) return;
      ++this.generation;
      this.retire();
      const status = object(error) ? error.status : undefined;
      const terminal = status === 401 || status === 403 || status === 404 || status === 409;
      const message = status === 409 ? "Session messaging paused because the published project changed. Load the latest publication."
        : terminal ? "Session messaging is unavailable for this signed-in project."
        : "Session messaging disconnected; reconnecting with a new session.";
      this.transport.status(false, message);
      const retryGeneration = this.generation;
      if (!terminal && !this.closed) this.retry = (this.transport.schedule ?? setTimeout)(() => {
        if (this.closed || this.generation !== retryGeneration) return;
        this.retry = undefined; void this.connect();
      }, Math.min(15000, 1000 * 2 ** Math.min(this.attempts++, 4)));
    };
    const timeout = (this.transport.schedule ?? setTimeout)(() => fail(), 10000); this.deadline = timeout;
    try {
      const registered = await this.transport.register(controller.signal);
      (this.transport.cancel ?? clearTimeout)(timeout);
      const identity = runtimeSessionIdentity(registered, this.projectId, this.publishedAt);
      if (!current()) { void this.transport.unregister(identity).catch(() => {}); return; }
      this.identity = identity;
      const stream = this.transport.open(identity); this.stream = stream;
      let ready = false;
      const heartbeat = () => {
        if (this.deadline !== undefined) (this.transport.cancel ?? clearTimeout)(this.deadline);
        this.deadline = (this.transport.schedule ?? setTimeout)(() => fail(), 15000);
      };
      this.deadline = (this.transport.schedule ?? setTimeout)(() => fail(), 10000);
      stream.addEventListener("ready", event => {
        if (!current()) return;
        try {
          const received = runtimeSessionIdentity(JSON.parse(event.data), this.projectId, this.publishedAt);
          if (received.sessionId !== identity.sessionId) throw new Error("Session identity changed during connection.");
          heartbeat();
          ready = true; this.attempts = 0; this.transport.status(true);
        } catch (error) { fail(error); }
      });
      stream.addEventListener("tags", event => {
        if (!current() || !ready) return;
        try { const values: unknown = JSON.parse(event.data); if (Array.isArray(values)) { heartbeat(); this.transport.tags(values); } }
        catch { /* The polling fallback and next frame can recover tag samples. */ }
      });
      stream.addEventListener("message", event => {
        if (!current() || !ready) return;
        try { const message = gatewaySessionMessage(JSON.parse(event.data), identity); heartbeat(); this.transport.message(message); }
        catch (error) { this.transport.status(true, error instanceof Error ? error.message : "Invalid gateway message."); }
      });
      stream.addEventListener("error", () => fail());
      stream.addEventListener("closed", () => fail());
    } catch (error) { if (current()) fail(error); }
    finally { (this.transport.cancel ?? clearTimeout)(timeout); }
  }
}
