import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "./Auth";
import { executeGatewayTool, supportsGatewayTool } from "./askSparkGatewayTools";
import { useAskSparkPrivateInputs } from "./askSparkPrivateInputs";
import { askSparkError, askSparkErrorCanRefreshStatus, askSparkProviderError, askSparkRequest, askSparkStorageKey, captureAskSparkContext, captureAskSparkExecutionContext, executeAskSparkCalls, isAskSparkShortcut, readAskSparkSession, requireAskSparkPreviewPermission, writeAskSparkSession } from "./askSparkClient";
import type { AiProviderError } from "./api";
import type { AskSparkContext, AskSparkConversation, AskSparkStatus, AskSparkStoredMessage, AskSparkToolCall, AskSparkToolImage, AskSparkToolResult, AskSparkTurn } from "./askSparkClient";
import { prepareAskSparkImage, type AskSparkImage } from "./askSparkImages";
import { openAskSparkProject, registerAskSparkNavigationContext } from "./askSparkProjectNavigation";
import { AskSparkRetainedImages } from "./askSparkRetainedImages";
import { cropRetainedImages } from "./askSparkImageCrops";
import { clearModelDraft } from "./modelWorkspace";
import { clearModelNavigation, installModelNavigationGuards, modelNavigationSubject, resolveModelNavigation, subscribeModelNavigation } from "./modelNavigation";

export interface AskSparkExecutionResult { result: unknown; summary?: string; undo?: () => void | Promise<void>; images?: AskSparkToolImage[]; contextUpdate?: AskSparkContext }
export interface AskSparkMutation { projectId: string; name: string }
type MutationListener = (event: AskSparkMutation, signal: AbortSignal) => Promise<void>;
export interface AskSparkExecutor { id: string; supports: (name: string) => boolean; execute: (name: string, args: Record<string, unknown>, context: AskSparkContext, signal: AbortSignal) => Promise<AskSparkExecutionResult | unknown> }
export interface AskSparkMessage { id: string; role: "user" | "assistant"; text: string; context?: AskSparkContext; images?: { name: string; preview?: string }[] }
export interface AskSparkAction { id: string; name: string; kind: string; status: "running" | "review" | "done" | "error" | "undone"; summary?: string; canUndo?: boolean }
interface Approval { call: AskSparkToolCall; resolve: (approved: boolean) => void }
interface AskSparkValue {
  open: boolean; setOpen: (open: boolean) => void; voiceRequest: number; requestVoice: () => void; consumeVoiceRequest: () => void;
  context: AskSparkContext; activeContext: AskSparkContext; pinned: boolean; togglePinned: () => void; removeContext: (keys: string[]) => void; refreshContext: () => void; restoreContext: () => void;
  registerContext: (ownerId: string, getter: () => AskSparkContext, priority?: number) => () => void; registerExecutor: (executor: AskSparkExecutor) => () => void;
  registerMutationListener: (ownerId: string, listener: MutationListener) => () => void;
  draft: string; setDraft: (text: string) => void; messages: AskSparkMessage[]; actions: AskSparkAction[]; busy: boolean; error: string; providerError?: AiProviderError; errorCanRefreshStatus: boolean; clearError: () => void;
  images: AskSparkImage[]; addImages: (files: File[]) => Promise<void>; removeImage: (id: string) => void; imagesBusy: boolean;
  retainedImagePreview: (id: string) => Pick<AskSparkImage, "preview" | "width" | "height" | "name"> | undefined;
  status: AskSparkStatus | null; refreshStatus: () => Promise<void>; send: () => Promise<void>; stop: () => void;
  approval: AskSparkToolCall | null; approve: (approved: boolean) => void; undo: (id: string) => Promise<void>;
  conversations: AskSparkConversation[]; loadHistory: () => Promise<void>; openConversation: (id: string) => Promise<void>; deleteConversation: (id: string) => Promise<boolean>; newConversation: () => void;
}
const Context = createContext<AskSparkValue | null>(null);
export function useAskSpark(): AskSparkValue { const value = useContext(Context); if (!value) throw new Error("Ask Spark is unavailable outside its provider."); return value; }
const uniqueId = () => crypto.randomUUID();
const messageRole = (value: AskSparkStoredMessage): "user" | "assistant" | null => value.role === "user" ? "user" : ["assistant", "model"].includes(value.role) ? "assistant" : null;
function storedMessages(messages: AskSparkStoredMessage[]): AskSparkMessage[] {
  return messages.flatMap(value => { const role = messageRole(value); return role ? [{ id: uniqueId(), role, text: value.text || value.content || "", context: value.context, images: value.images }] : []; });
}
function normalizeExecution(value: unknown): AskSparkExecutionResult {
  return value !== null && typeof value === "object" && "result" in value ? value as AskSparkExecutionResult : { result: value };
}
function resultError(result: unknown): string | undefined { return result !== null && typeof result === "object" && "error" in result && typeof result.error === "string" ? result.error : undefined; }

function ModelNavigationDialog() {
  const [pending, setPending] = useState(false), dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => subscribeModelNavigation(setPending), []);
  useEffect(() => { const element = dialog.current; if (pending) element?.showModal(); return () => element?.close(); }, [pending]);
  if (!pending) return null;
  return <dialog ref={dialog} className="project-dialog" aria-labelledby="model-navigation-title" aria-describedby="model-navigation-description" onCancel={event => { event.preventDefault(); resolveModelNavigation(false); }} onKeyDown={event => event.stopPropagation()}>
    <header><div className="eyebrow">UNSAVED CHANGES</div><h2 id="model-navigation-title">Leave {modelNavigationSubject()}?</h2></header>
    <div className="project-dialog-body"><p id="model-navigation-description">Your changes have not been saved. Stay to keep editing, or discard this draft and leave. Saved gateway data is unchanged.</p></div>
    <footer><button type="button" className="button" autoFocus onClick={() => resolveModelNavigation(false)}>Stay</button><button type="button" className="button project-archive-button" onClick={() => resolveModelNavigation(true)}>Discard draft and leave</button></footer>
  </dialog>;
}

export function AskSparkProvider({ children }: { children: ReactNode }) {
  const auth = useAuth(), inputs = useAskSparkPrivateInputs();
  useEffect(() => installModelNavigationGuards(), []);
  useEffect(() => () => clearModelNavigation(), [auth.user?.id]);
  const [open, setOpen] = useState(false), [voiceRequest, setVoiceRequest] = useState(0), [draft, setDraft] = useState("");
  const [context, setContext] = useState<AskSparkContext>({}), [pinned, setPinned] = useState(false);
  const [activeContext, setActiveContext] = useState<AskSparkContext>({});
  const [messages, setMessages] = useState<AskSparkMessage[]>([]), [actions, setActions] = useState<AskSparkAction[]>([]);
  const [status, setStatus] = useState<AskSparkStatus | null>(null), [busy, setBusy] = useState(false), [errorReason, setError] = useState<unknown>("");
  const error = askSparkError(errorReason), errorCanRefreshStatus = askSparkErrorCanRefreshStatus(errorReason);
  const providerError = askSparkProviderError(errorReason);
  const [approval, setApproval] = useState<AskSparkToolCall | null>(null), [conversations, setConversations] = useState<AskSparkConversation[]>([]);
  const [images, setImages] = useState<AskSparkImage[]>([]), [imagesBusy, setImagesBusy] = useState(false);
  const [loadedIdentity, setLoadedIdentity] = useState("");
  const imageDraft = useRef<AskSparkImage[]>([]), imageUrls = useRef(new Set<string>()), imageQueue = useRef(false);
  const retainedImages = useRef(new AskSparkRetainedImages());
  const contexts = useRef(new Map<string, { getter: () => AskSparkContext; priority: number }>()), executors = useRef(new Map<string, AskSparkExecutor>());
  const mutationListeners = useRef(new Map<string, MutationListener>());
  const currentContext = useRef(context), pin = useRef(false), excluded = useRef<string[]>([]);
  const conversation = useRef<string | undefined>(undefined), controller = useRef<AbortController | null>(null), approvalWait = useRef<Approval | null>(null);
  const undoActions = useRef(new Map<string, () => void | Promise<void>>()), lifecycle = useRef(0), currentStorage = useRef(""), undoing = useRef(false);
  const identity = auth.user && auth.audience === "engineering" ? askSparkStorageKey(auth.user.id, auth.audience) : "";
  const identityEpoch = auth.identityEpoch ?? auth.epoch;
  const releaseSentImages = useCallback(() => {
    retainedImages.current.clear();
    const keep = new Set(imageDraft.current.map(image => image.preview));
    for (const url of imageUrls.current) if (!keep.has(url)) { URL.revokeObjectURL(url); imageUrls.current.delete(url); }
  }, []);
  const refreshContext = useCallback(() => {
    const merged = Object.assign({}, ...[...contexts.current.values()].sort((a, b) => a.priority - b.priority).map(entry => entry.getter()));
    const active = captureAskSparkExecutionContext(merged);
    setActiveContext(previous => JSON.stringify(previous) === JSON.stringify(active) ? previous : active);
    if (pin.current) return;
    const next = { ...active };
    for (const key of excluded.current) delete next[key];
    currentContext.current = next;
    setContext(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, []);
  const registerContext = useCallback((ownerId: string, getter: () => AskSparkContext, priority = 0) => {
    const entry = { getter, priority }; contexts.current.set(ownerId, entry); refreshContext();
    return () => { if (contexts.current.get(ownerId) === entry) { contexts.current.delete(ownerId); refreshContext(); } };
  }, [refreshContext]);
  const registerExecutor = useCallback((executor: AskSparkExecutor) => { executors.current.set(executor.id, executor); return () => { if (executors.current.get(executor.id) === executor) executors.current.delete(executor.id); }; }, []);
  const registerMutationListener = useCallback((ownerId: string, listener: MutationListener) => { mutationListeners.current.set(ownerId, listener); return () => { if (mutationListeners.current.get(ownerId) === listener) mutationListeners.current.delete(ownerId); }; }, []);
  const workspaceContext = useCallback((): AskSparkContext => captureAskSparkExecutionContext(Object.assign({}, ...[...contexts.current.values()].sort((a, b) => a.priority - b.priority).map(entry => entry.getter()))), []);
  useEffect(() => registerAskSparkNavigationContext(workspaceContext), [workspaceContext]);
  const stop = useCallback(() => { controller.current?.abort(); controller.current = null; approvalWait.current?.resolve(false); approvalWait.current = null; setApproval(null); inputs.cancel(); setBusy(false); }, [inputs.cancel]);
  const refreshStatus = useCallback(async () => {
    const run = lifecycle.current;
    try { const next = await askSparkRequest<AskSparkStatus>("/status"); if (run === lifecycle.current) { setStatus(next); setError(""); } }
    catch (reason) { if (run === lifecycle.current) setError(reason); }
  }, []);
  const openConversation = useCallback(async (id: string) => {
    if (controller.current) return;
    const run = lifecycle.current, abort = new AbortController(); controller.current = abort; setBusy(true); setError("");
    try {
      const next = await askSparkRequest<{ messages: AskSparkStoredMessage[] }>(`/conversations/${encodeURIComponent(id)}`, "GET", undefined, abort.signal);
      if (run !== lifecycle.current || abort.signal.aborted) return;
      conversation.current = id; releaseSentImages(); setMessages(storedMessages(next.messages)); setActions([]); undoActions.current.clear();
      if (currentStorage.current) writeAskSparkSession(currentStorage.current, id, ""); setDraft("");
    } catch (reason) { if (run === lifecycle.current && !abort.signal.aborted) setError(reason); }
    finally { if (controller.current === abort) { controller.current = null; setBusy(false); } }
  }, [releaseSentImages]);
  useEffect(() => {
    lifecycle.current++; stop(); setMessages([]); setActions([]); setStatus(null); setError(""); setConversations([]); setOpen(false); setVoiceRequest(0);
    imageUrls.current.forEach(url => URL.revokeObjectURL(url)); imageUrls.current.clear(); imageDraft.current = []; retainedImages.current.clear(); setImages([]); setImagesBusy(false);
    undoActions.current.clear(); pin.current = false; setPinned(false); excluded.current = []; refreshContext();
    if (currentStorage.current && currentStorage.current !== identity) { clearModelDraft(); try { sessionStorage.removeItem(currentStorage.current); } catch { /* Storage may be disabled. */ } }
    currentStorage.current = identity; setLoadedIdentity(identity);
    const saved = identity ? readAskSparkSession(identity) : { draft: "" }; conversation.current = saved.conversationId; setDraft(saved.draft);
    if (identity) { void refreshStatus(); if (saved.conversationId) void openConversation(saved.conversationId).then(() => { if (currentStorage.current === identity) setDraft(saved.draft); }); }
    return () => { lifecycle.current++; controller.current?.abort(); approvalWait.current?.resolve(false); imageUrls.current.forEach(url => URL.revokeObjectURL(url)); imageUrls.current.clear(); };
  }, [identity, identityEpoch, openConversation, refreshContext, refreshStatus, stop]);
  useEffect(() => { if (identity && loadedIdentity === identity && currentStorage.current === identity) writeAskSparkSession(identity, conversation.current, draft); }, [draft, identity, loadedIdentity, messages]);
  useEffect(() => { const listener = () => { if (identity) void refreshStatus(); }; window.addEventListener("sparkstudio:ai-settings-changed", listener); return () => window.removeEventListener("sparkstudio:ai-settings-changed", listener); }, [identity, refreshStatus]);
  useEffect(() => { const listener = (event: KeyboardEvent) => { if (identity && isAskSparkShortcut(event)) { event.preventDefault(); setOpen(value => !value); } }; window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener); }, [identity]);
  const updateAction = (id: string, changes: Partial<AskSparkAction>) => setActions(current => current.map(item => item.id === id ? { ...item, ...changes } : item));
  const confirm = async (call: AskSparkToolCall, conversationId: string, signal: AbortSignal): Promise<boolean> => {
    if (!call.approvalToken) throw new Error("The gateway did not supply a confirmation token.");
    updateAction(call.id, { status: "review" }); setApproval(call);
    const approved = await new Promise<boolean>(resolve => { approvalWait.current = { call, resolve }; });
    approvalWait.current = null; setApproval(null); signal.throwIfAborted();
    const result = await askSparkRequest<{ approved: boolean; toolCalls: AskSparkToolCall[] }>("/confirm", "POST", { conversationId, token: call.approvalToken, approved }, signal);
    return approved && result.approved && result.toolCalls.some(item => item.id === call.id && item.name === call.name && item.authorized === true);
  };
  const openProjectTool = async (call: AskSparkToolCall, signal: AbortSignal): Promise<AskSparkExecutionResult> => {
    let next = await openAskSparkProject(String(call.arguments.projectId), workspaceContext, signal);
    let documentError: string | undefined;
    if (call.arguments.documentId) {
      const executor = [...executors.current.values()].find(item => item.supports("spark_designer_open_document"));
      try {
        if (!executor) throw new Error("The document editor is not ready.");
        const selected = normalizeExecution(await executor.execute("spark_designer_open_document", { documentId: call.arguments.documentId, documentKind: call.arguments.documentKind || "screen" }, next, signal));
        if (resultError(selected.result)) throw new Error(resultError(selected.result));
        next = selected.contextUpdate || workspaceContext();
      } catch (reason) { signal.throwIfAborted(); documentError = askSparkError(reason); }
    }
    return { result: { opened: true, projectId: next.projectId, documentId: next.documentId, documentKind: next.documentKind, ...(documentError ? { documentError } : {}) }, contextUpdate: next,
      summary: documentError ? `Project opened; document needs attention: ${documentError}` : "Opened project in Designer." };
  };
  const executeTool = async (call: AskSparkToolCall, captured: AskSparkContext, signal: AbortSignal, batch: { id: string; index: number }): Promise<AskSparkExecutionResult> => {
    requireAskSparkPreviewPermission(call);
    if (call.name === "spark_open_project") return openProjectTool(call, signal);
    if (call.name === "spark_designer_crop_image_assets") {
      if (!captured.projectId || workspaceContext().projectId !== captured.projectId) throw new Error("Open the target project before saving image crops.");
      const result = await cropRetainedImages({ projectId: captured.projectId, crops: call.arguments.crops, resolveImage: id => retainedImages.current.get(id), signal });
      return { result, summary: `Saved ${result.created.length} of ${result.requested} image crops.${result.error ? ` ${result.error}` : ""}` };
    }
    const executionContext = { ...captured, executionBatchId: batch.id, executionBatchIndex: batch.index,
      currentUserId: auth.user?.id, ownerId: auth.user?.id, currentUsername: auth.user?.username, resolveSecret: inputs.resolveSecret, resolveAttachment: inputs.resolveAttachment };
    const executor = [...executors.current.values()].find(item => item.supports(call.name));
    if (executor) return normalizeExecution(await executor.execute(call.name, call.arguments, executionContext, signal));
    if (supportsGatewayTool(call.name)) return { result: await executeGatewayTool(call.name, call.arguments, executionContext, signal) };
    throw new Error("This tool is unavailable in the current workspace. Open the relevant project or settings page.");
  };
  const refreshToolResources = async (call: AskSparkToolCall, receipt: AskSparkExecutionResult, captured: AskSparkContext, signal: AbortSignal) => {
    if (!captured.projectId || !/^(queries_(save|delete)|scripts_(save|delete)|assets_upload|spark_designer_crop_image_assets)$/.test(call.name)) return;
    if (resultError(receipt.result) && call.name !== "spark_designer_crop_image_assets") return;
    for (const listener of mutationListeners.current.values()) {
      try { await listener({ projectId: captured.projectId, name: call.name }, signal); }
      catch (reason) {
        signal.throwIfAborted();
        receipt.summary = `The operation finished, but the Designer could not refresh: ${askSparkError(reason)}`;
        receipt.result = receipt.result && typeof receipt.result === "object" && !Array.isArray(receipt.result)
          ? { ...receipt.result, refreshWarning: receipt.summary } : { operationResult: receipt.result, refreshWarning: receipt.summary };
      }
    }
  };
  const acceptContextUpdate = (call: AskSparkToolCall, receipt: AskSparkExecutionResult, captured: AskSparkContext) => {
    if (!receipt.contextUpdate || !["spark_open_project", "spark_designer_open_document"].includes(call.name)) return;
    Object.keys(captured).forEach(key => delete captured[key]);
    Object.assign(captured, captureAskSparkContext(receipt.contextUpdate), { availableImageIds: retainedImages.current.ids() });
    pin.current = false; excluded.current = []; setPinned(false); currentContext.current = captured; setContext({ ...captured });
  };
  const runTool = async (call: AskSparkToolCall, captured: AskSparkContext, conversationId: string, signal: AbortSignal, batch: { id: string; index: number }): Promise<AskSparkToolResult> => {
    setActions(current => [...current, { id: call.id, name: call.name, kind: call.kind, status: "running" }]);
    try {
      requireAskSparkPreviewPermission(call);
      if (call.confirmation && !await confirm(call, conversationId, signal)) throw new Error("User declined this operation.");
      if (!call.confirmation && call.authorized !== true) throw new Error("The gateway did not authorize this operation.");
      signal.throwIfAborted(); updateAction(call.id, { status: "running" });
      const receipt = await executeTool(call, captured, signal, batch);
      if (signal.aborted) updateAction(call.id, { status: resultError(receipt.result) ? "error" : "done", summary: receipt.summary || "The operation returned after cancellation. Inspect its current state before retrying." });
      signal.throwIfAborted();
      acceptContextUpdate(call, receipt, captured);
      await refreshToolResources(call, receipt, captured, signal);
      const failure = resultError(receipt.result);
      if (receipt.undo && !failure) undoActions.current.set(call.id, receipt.undo);
      updateAction(call.id, { status: failure ? "error" : "done", summary: failure || receipt.summary || "Completed", canUndo: Boolean(receipt.undo && !failure) });
      refreshContext(); return { id: call.id, name: call.name, result: receipt.result, ...(receipt.images ? { images: receipt.images } : {}) };
    } catch (reason) { const text = askSparkError(reason); if (!signal.aborted) updateAction(call.id, { status: "error", summary: text }); return { id: call.id, name: call.name, result: { error: text } }; }
  };
  const runTurns = async (initial: AskSparkTurn, captured: AskSparkContext, signal: AbortSignal) => {
    let response = initial;
    // The server snapshots the configured limit for each message (1–1000, default 100).
    // Allow its final tool-free response; this is only a malformed-server safety bound.
    for (let step = 0; step <= 1000; step++) {
      signal.throwIfAborted(); conversation.current = response.conversationId;
      if (response.reply) setMessages(current => [...current, { id: uniqueId(), role: "assistant", text: response.reply! }]);
      const calls = response.toolCalls || []; if (!calls.length) return;
      if (step === 1000) break;
      const batchId = uniqueId();
      const toolResults = await executeAskSparkCalls(calls, call => runTool(call, captured, response.conversationId, signal, { id: batchId, index: calls.indexOf(call) }), status?.parallelLimit || 1, signal);
      signal.throwIfAborted();
      Object.assign(captured, captureAskSparkExecutionContext(captured));
      response = await askSparkRequest<AskSparkTurn>("/turn", "POST", { conversationId: response.conversationId, context: captured, continuationToken: response.continuationToken, toolResults }, signal);
    }
    throw new Error("This request reached its tool-step limit. Review the completed changes before continuing.");
  };
  const send = async () => {
    if (controller.current || (!draft.trim() && !imageDraft.current.length) || !identity || imageQueue.current || !status?.enabled || !status.configured) return;
    const text = draft.trim() || "Describe the attached image(s)."; refreshContext(); const captured = captureAskSparkExecutionContext(currentContext.current);
    const attached = [...imageDraft.current]; retainedImages.current.add(attached); captured.availableImageIds = retainedImages.current.ids(); imageDraft.current = []; setImages([]);
    const abort = new AbortController(); controller.current = abort; setBusy(true); setError(""); setDraft("");
    setMessages(current => [...current, { id: uniqueId(), role: "user", text, context: captureAskSparkContext(captured), images: attached.map(image => ({ name: image.name, preview: image.preview })) }]);
    try { const response = await askSparkRequest<AskSparkTurn>("/turn", "POST", { conversationId: conversation.current, message: text, context: captured, images: attached.map(({ data, mimeType, name, id }) => ({ data, mimeType, name, id })) }, abort.signal); await runTurns(response, captured, abort.signal); }
    catch (reason) { if (!abort.signal.aborted) setError(reason); }
    finally { if (controller.current === abort) { controller.current = null; setBusy(false); setApproval(null); } }
  };
  const loadHistory = async () => { const run = lifecycle.current; try { const result = await askSparkRequest<{ conversations: AskSparkConversation[] }>("/conversations"); if (run === lifecycle.current) setConversations(result.conversations); } catch (reason) { if (run === lifecycle.current) setError(reason); } };
  const deleteConversation = async (id: string): Promise<boolean> => {
    if (controller.current) return false;
    const run = lifecycle.current, abort = new AbortController(); controller.current = abort; setBusy(true); setError("");
    try {
      await askSparkRequest(`/conversations/${encodeURIComponent(id)}`, "DELETE", undefined, abort.signal);
      if (run !== lifecycle.current || abort.signal.aborted) return false;
      setConversations(current => current.filter(item => item.id !== id));
      if (conversation.current === id) {
        conversation.current = undefined; releaseSentImages(); setMessages([]); setActions([]); undoActions.current.clear();
        if (identity) writeAskSparkSession(identity, undefined, draft);
      }
      return true;
    } catch (reason) { if (run === lifecycle.current && !abort.signal.aborted) setError(reason); return false; }
    finally { if (controller.current === abort) { controller.current = null; setBusy(false); } }
  };
  const newConversation = () => { if (controller.current) return; conversation.current = undefined; releaseSentImages(); setMessages([]); setActions([]); setError(""); undoActions.current.clear(); if (identity) writeAskSparkSession(identity, undefined, draft); };
  const undo = async (id: string) => { const action = undoActions.current.get(id); if (!action || controller.current || undoing.current) return; undoing.current = true; try { await action(); undoActions.current.delete(id); updateAction(id, { status: "undone", canUndo: false, summary: "Draft changes undone" }); refreshContext(); } catch (reason) { setError(reason); } finally { undoing.current = false; } };
  const togglePinned = () => { pin.current = !pin.current; setPinned(pin.current); if (!pin.current) { excluded.current = []; refreshContext(); } };
  const removeContext = (keys: string[]) => { excluded.current.push(...keys); const next = { ...currentContext.current }; keys.forEach(key => delete next[key]); currentContext.current = next; setContext(next); };
  const restoreContext = () => { excluded.current = []; pin.current = false; setPinned(false); refreshContext(); };
  const addImages = async (files: File[]) => {
    if (imageQueue.current) return; const run = lifecycle.current; imageQueue.current = true; setImagesBusy(true); setError("");
    try { for (const file of files) { const image = await prepareAskSparkImage(file, imageDraft.current); if (run !== lifecycle.current) { URL.revokeObjectURL(image.preview); return; } try { retainedImages.current.assertCapacity([...imageDraft.current, image]); } catch (reason) { URL.revokeObjectURL(image.preview); throw reason; } imageUrls.current.add(image.preview); imageDraft.current = [...imageDraft.current, image]; setImages(imageDraft.current); } }
    catch (reason) { if (run === lifecycle.current) setError(reason); }
    finally { imageQueue.current = false; if (run === lifecycle.current) setImagesBusy(false); }
  };
  const removeImage = (id: string) => { const image = imageDraft.current.find(item => item.id === id); if (image) { URL.revokeObjectURL(image.preview); imageUrls.current.delete(image.preview); } imageDraft.current = imageDraft.current.filter(item => item.id !== id); setImages(imageDraft.current); };
  const retainedImagePreview = (id: string) => {
    if (loadedIdentity !== identity) return undefined;
    try { const { preview, width, height, name } = retainedImages.current.get(id); return { preview, width, height, name }; }
    catch { return undefined; }
  };
  const value: AskSparkValue = { open, setOpen, voiceRequest, requestVoice: () => { setOpen(true); setVoiceRequest(value => value + 1); }, consumeVoiceRequest: () => setVoiceRequest(0),
    context, activeContext, pinned, togglePinned, removeContext, refreshContext, restoreContext, registerContext, registerExecutor, registerMutationListener, draft, setDraft, messages, actions, busy, error, providerError, errorCanRefreshStatus, clearError: () => setError(""), status, refreshStatus, send, stop,
    approval, approve: approved => approvalWait.current?.resolve(approved), undo, conversations, loadHistory, openConversation, deleteConversation, newConversation, images, imagesBusy, addImages, removeImage, retainedImagePreview };
  // Do not expose the previous account's state during the render before effect cleanup.
  if (loadedIdentity !== identity) Object.assign(value, { open: false, draft: "", messages: [], actions: [], images: [], conversations: [], approval: null, status: null, error: "", providerError: undefined, errorCanRefreshStatus: false, busy: false });
  return <Context.Provider value={value}>{children}{loadedIdentity === identity && auth.user ? <>{inputs.dialog}<ModelNavigationDialog /></> : null}</Context.Provider>;
}
