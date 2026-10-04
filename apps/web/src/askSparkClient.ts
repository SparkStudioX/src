import { api, ApiError } from "./api";
import { previewRequestState } from "./previewRequest";

export type AskSparkContext = Record<string, unknown> & { surface?: string; projectId?: string; projectName?: string; documentId?: string; documentName?: string; documentKind?: string; selectedComponentIds?: string[]; revision?: number; section?: string; connectionId?: string; connectionName?: string; connectionSection?: string; connectionHasUnsavedChanges?: boolean; modelView?: string; modelType?: string; modelSelection?: string[]; modelDraftSummary?: string; modelResolution?: string[] };
export interface AskSparkToolCall { id: string; name: string; arguments: Record<string, unknown>; kind: string; target?: string; confirmation?: boolean | string; parallelSafe?: boolean; approvalToken?: string; authorized?: boolean }
export interface AskSparkToolImage { data: string; mimeType: string; name?: string; id?: string }
export interface AskSparkToolResult { id: string; name: string; result: unknown; images?: AskSparkToolImage[] }
export interface AskSparkTurn { conversationId: string; reply?: string; toolCalls?: AskSparkToolCall[]; continuationToken?: string }
export interface AskSparkStatus { enabled: boolean; configured?: boolean; hasApiKey?: boolean; model: string; parallelLimit?: number; available?: boolean }
export interface AskSparkConversation { id: string; title?: string; updatedAt?: string }
export interface AskSparkStoredMessage { role: string; content?: string; text?: string; context?: AskSparkContext; images?: { name: string }[] }
export interface AskSparkSettings { revision: string; enabled: boolean; model: string; hasApiKey: boolean; parallelLimit: number; monthlyTokenLimit: number; modelStepLimit: number; loggingEnabled: boolean }
export interface AskSparkUsage { month: string; limit: number; usedTokens: number; cachedTokens: number; totalTokens: number; requests: number; uncertainRequests: number; resetsAt: string; inputTokens: number | null; outputTokens: number | null; thoughtTokens: number | null; unclassifiedTokens: number }
export const defaultAskSparkModel = "gemini-3.8-flash";
export const askSparkRequest = <T,>(path: string, method = "GET", body?: unknown, signal?: AbortSignal) => api<T>(`/ask-spark${path}`, method, body, signal);
export const askSparkError = (error: unknown) => error instanceof Error ? error.message : String(error);
export const askSparkProviderError = (error: unknown) => error instanceof ApiError ? error.aiProviderError : undefined;
/** Tool, context, permission and size errors are not provider connection failures. */
export const askSparkErrorCanRefreshStatus = (error: unknown) => error instanceof ApiError && !error.aiProviderError && [502, 503, 504].includes(error.status);

/** Only bounded JSON context is transmitted. Secrets and execution callbacks stay outside it. */
export function captureAskSparkContext(context: AskSparkContext): AskSparkContext {
  const allowed = ["surface", "editorAvailable", "snapshotToken", "projectId", "projectName", "documentId", "documentName", "documentKind", "selectedComponentIds", "selectedComponentNames", "revision", "scriptsRevision", "section", "connectionId", "connectionName", "connectionSection", "connectionHasUnsavedChanges", "modelView", "modelType", "modelSelection", "modelDraftSummary", "modelResolution", "tagPaths", "selection", "screenId", "screenName", "templateId", "unsavedChanges", "availableImageIds", "previewActive", "previewMode"];
  const captured: AskSparkContext = {};
  for (const key of allowed) {
    const value = context[key];
    if (typeof value === "string") captured[key] = value.slice(0, 512);
    else if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) captured[key] = value;
    else if (Array.isArray(value)) captured[key] = value.filter(item => typeof item === "string").slice(0, 100).map(item => item.slice(0, 512));
  }
  return captured;
}

/** Preview is live UI state, even when the user pins older document context. */
export function captureAskSparkExecutionContext(context: AskSparkContext): AskSparkContext {
  return captureAskSparkContext({ ...context, ...previewRequestState() });
}

export function requireAskSparkPreviewPermission(call: Pick<AskSparkToolCall, "name" | "kind">): void {
  if (previewRequestState().previewActive && (call.kind !== "read" || call.name === "spark_open_project"))
    throw new Error("Exit Designer Preview before editing, saving, publishing, running actions, or opening another project. Ask Spark can still inspect the current screen and discuss it.");
}

/** Connection context contains display metadata only, never editable credentials or configuration. */
export function connectionAskSparkContext(savedId: string | undefined, name: string | undefined, section: string, hasUnsavedChanges: boolean): AskSparkContext {
  return {
    section: "connections", connectionId: savedId, connectionName: name, connectionSection: section, connectionHasUnsavedChanges: hasUnsavedChanges,
    documentId: undefined, documentName: undefined, documentKind: undefined, selectedComponentIds: undefined, selectedComponentNames: undefined,
    screenId: undefined, screenName: undefined, templateId: undefined, selection: undefined, snapshotToken: undefined,
  };
}

export function contextChips(context: AskSparkContext): { key: string; label: string; remove: string[] }[] {
  const chips: { key: string; label: string; remove: string[] }[] = [];
  if (context.projectId) chips.push({ key: "project", label: context.projectName || context.projectId, remove: ["projectId", "projectName", "documentId", "documentName", "documentKind", "revision", "scriptsRevision", "selectedComponentIds", "selectedComponentNames"] });
  if (context.documentId) chips.push({ key: "document", label: context.documentName || context.documentId, remove: ["documentId", "documentName", "documentKind", "selectedComponentIds", "selectedComponentNames"] });
  const selected = context.selectedComponentIds;
  if (selected?.length) chips.push({ key: "selection", label: `${selected.length} selected`, remove: ["selectedComponentIds", "selectedComponentNames"] });
  if (context.section) chips.push({ key: "section", label: context.section, remove: ["section", "connectionId", "connectionName", "connectionSection", "connectionHasUnsavedChanges", "tagPaths"] });
  if (context.modelView) chips.push({ key: "model", label: `Models · ${context.modelView}${context.modelType ? ` · ${context.modelType}` : ""}`, remove: ["modelView", "modelType", "modelSelection", "modelDraftSummary", "modelResolution"] });
  if (context.connectionId || context.connectionName) chips.push({ key: "connection", label: `${context.connectionName || context.connectionId}${context.connectionHasUnsavedChanges ? " · unsaved" : ""}`, remove: ["connectionId", "connectionName", "connectionSection", "connectionHasUnsavedChanges"] });
  return chips;
}

export function isAskSparkShortcut(event: KeyboardEvent): boolean {
  if (!(event.altKey && event.key.toLowerCase() === "a") || event.ctrlKey || event.metaKey || event.repeat) return false;
  const target = event.target;
  return !(target instanceof Element && target.closest("input,textarea,select,[contenteditable='true'],.cm-editor,dialog[open]"));
}

/** Parallelize only explicitly safe reads, in adjacent runs; writes are ordered barriers. */
export async function executeAskSparkCalls(calls: AskSparkToolCall[], execute: (call: AskSparkToolCall) => Promise<AskSparkToolResult>, parallelLimit: number, signal: AbortSignal): Promise<AskSparkToolResult[]> {
  const results: AskSparkToolResult[] = [];
  const limit = Math.max(1, Math.min(8, Math.trunc(parallelLimit) || 1));
  let index = 0;
  while (index < calls.length) {
    signal.throwIfAborted();
    const batch: AskSparkToolCall[] = [];
    while (index < calls.length && batch.length < limit && parallelRead(calls[index])) batch.push(calls[index++]);
    if (batch.length) results.push(...await Promise.all(batch.map(execute)));
    else results.push(await execute(calls[index++]));
  }
  return results;
}
const parallelRead = (call: AskSparkToolCall) => call.kind === "read" && call.parallelSafe === true && !call.confirmation;

export function askSparkStorageKey(userId: string, audience: string): string { return `sparkstudio.ask-spark.${audience}.${encodeURIComponent(userId)}`; }
export function readAskSparkSession(key: string): { conversationId?: string; draft: string } {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || "{}");
    return { conversationId: typeof value.conversationId === "string" ? value.conversationId.slice(0, 128) : undefined, draft: typeof value.draft === "string" ? value.draft.slice(0, 8000) : "" };
  } catch { return { draft: "" }; }
}
export function writeAskSparkSession(key: string, conversationId: string | undefined, draft: string): void {
  try { sessionStorage.setItem(key, JSON.stringify({ conversationId, draft: draft.slice(0, 8000) })); } catch { /* A blocked store must not prevent conversation use. */ }
}
