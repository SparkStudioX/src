import { useEffect, useId, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import Icon from "./Icon";
import { useAuth } from "./Auth";
import { useAskSpark } from "./askSparkContext";
import type { AskSparkAction, AskSparkMessage } from "./askSparkContext";
import type { AiProviderError } from "./api";
import { contextChips } from "./askSparkClient";
import { useAskSparkVoice } from "./askSparkVoice";
import AskSparkMarkdown from "./AskSparkMarkdown";
import { AskSparkCropReview } from "./AskSparkCropReview";
import "./askSpark.css";

function Microphone({ size = 16 }: { size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" /></svg>; }
function ImageIcon() { return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 6-6 4 4 3-3 5 5" /></svg>; }
export function AskSparkErrorAlert({ message, providerError, recovery, onDismiss, onRefreshStatus }: { message: string; providerError?: AiProviderError; recovery?: string; onDismiss: () => void; onRefreshStatus?: () => void }) {
  const alert = useRef<HTMLDivElement>(null);
  useEffect(() => { alert.current?.scrollIntoView({ block: "nearest" }); }, [message, providerError]);
  return <div ref={alert} className="ask-spark-error" role="alert" aria-label="Ask Spark error" aria-atomic="true">
    {providerError && <strong className="ask-spark-error-title">{providerError.provider} · {providerError.httpStatus}{providerError.status ? ` ${providerError.status}` : ""}</strong>}
    <p>{message}</p>
    {providerError?.message && <p className="ask-spark-error-detail" tabIndex={0} aria-label="Gemini error details">{providerError.message}</p>}
    {providerError && recovery && <p>{recovery}</p>}
    <div className="ask-spark-error-actions">{onRefreshStatus && !providerError && <button type="button" onClick={onRefreshStatus}>Refresh AI status</button>}<button type="button" onClick={onDismiss}>Dismiss</button></div>
  </div>;
}
export function AskSparkLauncher({ className = "" }: { className?: string }) {
  const ask = useAskSpark(), auth = useAuth();
  if (!auth.user || auth.audience !== "engineering") return null;
  return <div className={`ask-spark-launcher ${className}`}>
    <button type="button" className={ask.open ? "active" : ""} onClick={() => ask.setOpen(!ask.open)} aria-expanded={ask.open} aria-controls="ask-spark-panel" title="Ask Spark (Alt+A)"><Icon name="spark" size={15} /><span>Ask Spark</span>{ask.approval && <span className="ask-spark-launcher-dot" aria-label="Review required" />}</button>
    <button type="button" className="ask-spark-launcher-mic" aria-label="Open Ask Spark and dictate a message" title="Dictate a message" onClick={ask.requestVoice}><Microphone /></button>
  </div>;
}
function Message({ message }: { message: AskSparkMessage }) {
  return <article className={`ask-spark-message ${message.role}`} aria-label={message.role === "user" ? "Your message" : "Ask Spark response"}>
    <div className="ask-spark-message-label">{message.role === "user" ? "You" : <><Icon name="spark" size={12} /> Ask Spark</>}</div>
    {message.context && <div className="ask-spark-sent-context">{contextChips(message.context).map(chip => <span key={chip.key}>{chip.label}</span>)}</div>}
    {message.images?.length ? <div className="ask-spark-message-images">{message.images.map((image, index) => image.preview ? <img key={index} src={image.preview} alt={image.name} /> : <span key={index}><ImageIcon />{image.name}</span>)}</div> : null}
    {message.role === "assistant" ? <AskSparkMarkdown text={message.text} /> : <div className="ask-spark-answer">{message.text}</div>}
  </article>;
}
function ToolAction({ action }: { action: AskSparkAction }) {
  const ask = useAskSpark();
  return <li className={`ask-spark-tool ${action.status}`}><div><Icon name={action.status === "done" ? "check" : "code"} size={13} /><strong>{action.name.replaceAll("_", " ")}</strong><span>{action.status === "review" ? "Awaiting review" : action.status}</span></div>
    {action.summary && <p>{action.summary}</p>}{action.canUndo && <button type="button" className="button" disabled={ask.busy} onClick={() => void ask.undo(action.id)}>Undo draft changes</button>}</li>;
}
function ApprovalCard() {
  const ask = useAskSpark(), call = ask.approval;
  const [responding, setResponding] = useState(false);
  useEffect(() => setResponding(false), [call?.id]);
  if (!call) return null;
  const answer = (approved: boolean) => { setResponding(true); ask.approve(approved); };
  return <section className="ask-spark-approval" aria-labelledby="ask-spark-approval-title"><h3 id="ask-spark-approval-title">Review this operation</h3><p>{call.name.replaceAll("_", " ")}</p>{call.target && <small>Target: {call.target}</small>}
    {call.name === "spark_designer_crop_image_assets" && <AskSparkCropReview crops={call.arguments.crops} resolveImage={ask.retainedImagePreview} />}
    <details open><summary>Exact arguments</summary><pre>{JSON.stringify(call.arguments, null, 2)}</pre></details>
    <div><button type="button" className="button" disabled={responding} onClick={() => answer(false)}>Decline</button><button type="button" className="button primary" disabled={responding} onClick={() => answer(true)}>{responding ? "Continuing…" : "Approve operation"}</button></div>
  </section>;
}
function ContextChips() {
  const ask = useAskSpark(), chips = contextChips(ask.context);
  return <section className="ask-spark-context" aria-label="Context for the next message"><div className="ask-spark-context-heading"><span>{ask.pinned ? "Pinned context" : "Current context"}</span><span><button type="button" onClick={ask.restoreContext}>Reset</button> · <button type="button" aria-pressed={ask.pinned} onClick={ask.togglePinned}>{ask.pinned ? "Unpin" : "Pin"}</button></span></div>
    <div className="ask-spark-chips">{chips.length ? chips.map(chip => <span key={chip.key} title={chip.label}>{chip.label}<button type="button" aria-label={`Remove ${chip.label} context`} onClick={() => ask.removeContext(chip.remove)}>×</button></span>) : <small>No resource selected</small>}</div>
  </section>;
}
function History({ onSelect }: { onSelect: () => void }) {
  const ask = useAskSpark(), [pending, setPending] = useState<{ id: string; title: string } | null>(null);
  const remove = async () => { if (pending && await ask.deleteConversation(pending.id)) setPending(null); };
  return <section className="ask-spark-history" aria-label="Previous conversations"><h3>Recent conversations</h3>{ask.conversations.length ? ask.conversations.map(item => <div key={item.id} className="ask-spark-history-row"><button type="button" disabled={ask.busy} onClick={() => { void ask.openConversation(item.id); onSelect(); }}><span>{item.title || "Conversation"}</span>{item.updatedAt && <small>{new Date(item.updatedAt).toLocaleDateString()}</small>}</button><button type="button" className="ask-spark-history-delete" disabled={ask.busy} aria-label={`Delete ${item.title || "conversation"}`} onClick={() => setPending({ id: item.id, title: item.title || "this conversation" })}>Delete</button></div>) : <p>No previous conversations.</p>}
    {pending && <div className="ask-spark-history-confirm" role="group" aria-label="Confirm conversation deletion"><p>Delete “{pending.title}” and its saved messages? This cannot be undone.</p><div><button type="button" className="button" disabled={ask.busy} onClick={() => setPending(null)}>Keep</button><button type="button" className="button" disabled={ask.busy} onClick={() => void remove()}>Delete conversation</button></div></div>}
  </section>;
}
function Suggestions() {
  const ask = useAskSpark(), designer = ask.context.surface === "designer";
  const prompts = designer ? ["Explain the selected component and its bindings", "Find broken bindings in this project", "Help me build an equipment faceplate"] : ["Check gateway health and explain any problems", "Help me set up a connection", "Find tags with bad quality"];
  return <div className="ask-spark-welcome"><div className="ask-spark-welcome-mark"><Icon name="spark" size={23} /></div><h3>What would you like to build?</h3><p>Describe a change, ask about a setting, or paste a screenshot. I can use your current workspace as context.</p><div>{prompts.map(text => <button type="button" key={text} onClick={() => ask.setDraft(text)}>{text}<Icon name="arrow" size={12} /></button>)}</div></div>;
}
function Composer() {
  const ask = useAskSpark(), id = useId(), textarea = useRef<HTMLTextAreaElement>(null), files = useRef<HTMLInputElement>(null);
  const voice = useAskSparkVoice(text => ask.setDraft(`${ask.draft}${ask.draft.trim() ? "\n" : ""}${text}`.slice(0, 8000)));
  const ready = ask.status?.enabled && ask.status.configured !== false;
  useEffect(() => { if (ask.voiceRequest) { ask.consumeVoiceRequest(); if (ready) void voice.start(); else textarea.current?.focus(); } }, [ask.voiceRequest, ready, voice.start]);
  useEffect(() => { if (!ask.open) voice.cancel(); }, [ask.open, voice.cancel]);
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => { const images = [...event.clipboardData.items].filter(item => item.kind === "file" && item.type.startsWith("image/")).map(item => item.getAsFile()).filter((file): file is File => file !== null); if (images.length) { event.preventDefault(); void ask.addImages(images); } };
  const key = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!voice.busy) void ask.send(); } };
  return <form className="ask-spark-composer" onSubmit={event => { event.preventDefault(); void ask.send(); }}>
    {ask.images.length > 0 && <div className="ask-spark-attachments" aria-label="Images attached to draft">{ask.images.map(image => <div key={image.id}><img src={image.preview} alt={image.name} /><button type="button" aria-label={`Remove ${image.name}`} onClick={() => ask.removeImage(image.id)}>×</button><small title={image.name}>{image.name}</small></div>)}</div>}
    <label className="ask-spark-sr-only" htmlFor={`${id}-message`}>Message to Ask Spark</label>
    <textarea id={`${id}-message`} ref={textarea} value={ask.draft} maxLength={8000} rows={3} onPaste={paste} onKeyDown={key} onChange={event => ask.setDraft(event.target.value)} placeholder="Ask, describe a change, or paste an image…" aria-describedby={`${id}-privacy`} />
    {voice.busy && <div className="ask-spark-voice-state" role="status"><span className={voice.phase === "recording" ? "recording" : ""} />{voice.phase === "recording" ? "Listening · up to 60 seconds" : voice.phase === "requesting" ? "Waiting for microphone permission…" : "Transcribing…"}{voice.phase === "recording" && <button type="button" onClick={voice.stop}>Stop recording</button>}<button type="button" onClick={voice.cancel}>Cancel</button></div>}
    {voice.error && <AskSparkErrorAlert message={voice.error} providerError={voice.providerError} onDismiss={voice.clearError} recovery="Your draft is unchanged. Record again when you are ready; the audio is not resent automatically." />}
    <div className="ask-spark-composer-actions"><input ref={files} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={event => { void ask.addImages([...event.target.files || []]); event.target.value = ""; }} />
      <button type="button" className="ask-spark-icon-button" title="Attach images (or paste a screenshot)" aria-label="Attach images" disabled={ask.imagesBusy || ask.images.length >= 4} onClick={() => files.current?.click()}><ImageIcon /></button>
      <button type="button" className="ask-spark-icon-button" title="Dictate, then edit and send" aria-label="Dictate a message" aria-pressed={voice.phase === "recording"} disabled={ask.busy || voice.busy || !ready} onClick={() => void voice.start()}><Microphone /></button><span>{ask.imagesBusy ? "Preparing image…" : "Shift+Enter for a new line"}</span>
      {ask.busy ? <button type="button" className="button" onClick={ask.stop}><Icon name="stop" size={12} />Stop</button> : <button className="button primary" disabled={(!ask.draft.trim() && !ask.images.length) || !ready || voice.busy || ask.imagesBusy}>Send<Icon name="arrow" size={12} /></button>}
    </div><p id={`${id}-privacy`} className="ask-spark-privacy">Messages, attached images and selected context go to Gemini. Voice is transcribed by Gemini; review the text before sending. Enter credentials only in secure prompts.</p>
  </form>;
}

export function AskSparkPanel({ className = "", onOpenSettings }: { className?: string; onOpenSettings?: () => void }) {
  const ask = useAskSpark(), auth = useAuth(), [history, setHistory] = useState(false), panel = useRef<HTMLElement>(null), end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ask.open) { const previous = document.activeElement; panel.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; } }, [ask.open]);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [ask.messages.length, ask.actions.length, ask.approval]);
  if (!auth.user || auth.audience !== "engineering" || !ask.open) return null;
  return <aside id="ask-spark-panel" ref={panel} className={`ask-spark-panel ${className}`} aria-labelledby="ask-spark-title" onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); ask.setOpen(false); } }}>
    <header className="ask-spark-heading"><div><span className="ask-spark-brand"><Icon name="spark" size={16} /><h2 id="ask-spark-title">Ask Spark</h2></span><small>Your workspace, in conversation</small></div><div>
      <button type="button" className="ask-spark-icon-button" title="Previous conversations" aria-label="Previous conversations" aria-expanded={history} disabled={ask.busy} onClick={() => { setHistory(!history); if (!history) void ask.loadHistory(); }}><Icon name="layers" size={15} /></button>
      <button type="button" className="ask-spark-icon-button" title="New conversation" aria-label="New conversation" disabled={ask.busy} onClick={() => { ask.newConversation(); setHistory(false); }}><Icon name="plus" size={16} /></button>
      <button type="button" className="ask-spark-icon-button" title="Close Ask Spark" aria-label="Close Ask Spark" onClick={() => ask.setOpen(false)}><Icon name="close" size={16} /></button>
    </div></header><ContextChips />
    {history && <History onSelect={() => setHistory(false)} />}
    <div className="ask-spark-thread" role="log" aria-label="Ask Spark conversation" aria-live="polite" aria-relevant="additions text">
      {ask.status && (!ask.status.enabled || !ask.status.configured) && <div className="ask-spark-setup"><h3>Connect Ask Spark</h3><p>A gateway administrator can enable Gemini in AI settings.</p>{auth.gatewayAdmin && (onOpenSettings ? <button type="button" className="button" onClick={onOpenSettings}>Open AI settings</button> : <a className="button" href="/gateway?section=ai">Open AI settings</a>)}</div>}
      {!ask.messages.length && <Suggestions />}{ask.messages.map(message => <Message key={message.id} message={message} />)}
      {ask.actions.length > 0 && <details className="ask-spark-actions" open><summary>Tool activity · {ask.actions.length}</summary><ol>{ask.actions.map(action => <ToolAction key={action.id} action={action} />)}</ol></details>}
      <ApprovalCard />{ask.busy && !ask.approval && <p className="ask-spark-working" role="status"><span />Working… <small>Stopping does not undo completed actions.</small></p>}
      {ask.error && <AskSparkErrorAlert message={ask.error} providerError={ask.providerError} onDismiss={ask.clearError} onRefreshStatus={ask.errorCanRefreshStatus ? () => void ask.refreshStatus() : undefined} recovery="Ask Spark has stopped. Your conversation and completed changes are kept. Review tool activity before sending a new message." />}<div ref={end} />
    </div><Composer /><footer className="ask-spark-footer"><span>{ask.status?.model || "Gemini"}</span><span>{ask.pinned ? "Context pinned" : "Follows your workspace"}</span></footer>
  </aside>;
}
