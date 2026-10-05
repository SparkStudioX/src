import { useEffect, useRef, useState } from "react";
import type { ModelPackage } from "./modelWorkspace";
import type { WorkspaceReview } from "./useModelWorkspace";
import ModelReview from "./modelWorkspaceReview";

export function ModelWorkspaceReviewPanel({ review, error, count, busy, onApply, onPreview, onClose, onDiscard, onNavigate, model }: { review: WorkspaceReview | null; error: string; count: number; busy: boolean; onApply: () => void; onPreview: () => void; onClose: () => void; onDiscard: () => void; onNavigate: (path: string) => void; model: ModelPackage }) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { const previous = document.activeElement; panel.current?.focus({ preventScroll: true }); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); }; }, []);
  return <aside className="model-review-panel" aria-label="Review model draft" tabIndex={-1} ref={panel} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}><header><div><strong>Ready to use your changes?</strong><small>{count} changed items across models, equipment and settings</small></div><button type="button" className="button primary" disabled={busy || !review?.preview.canApply} onClick={onApply}>Apply {count} changes</button><button type="button" className="button small" aria-label="Close model review" onClick={onClose}>×</button></header>
    <div className="model-review-scroll"><p>Check the changed items and their affected fields below. Applying makes them available to projects on this gateway.</p>{busy && !review && <p role="status">Checking your changes…</p>}{error && <p className="security-error" role="alert">{error}</p>}{!busy && !review && <p>Your draft changed since the last check. Refresh the review to check it again.</p>}{review && <ModelReview preview={review.preview} model={model} onNavigate={onNavigate} />}</div>
    <footer className="model-actions"><button type="button" className="button" disabled={busy || !count} onClick={onPreview}>Refresh review</button><button type="button" className="button danger" disabled={busy || !count} onClick={onDiscard}>Discard draft</button></footer></aside>;
}
export function ModelImportPanel({ onImport, onClose }: { onImport: (text: string) => void; onClose: () => void }) {
  const [text, setText] = useState(""), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const serial = useRef(0), panel = useRef<HTMLElement>(null);
  useEffect(() => { const previous = document.activeElement; panel.current?.focus({ preventScroll: true }); return () => { serial.current++; if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); }; }, []);
  async function read(file?: File) {
    if (!file) return; const stamp = ++serial.current; setLoading(true);
    try { if (file.size > 32 * 1024 * 1024) throw new Error("Model imports are limited to 32 MiB."); const value = await file.text(); if (serial.current === stamp) { setText(value); setError(""); } }
    catch (reason) { if (serial.current === stamp) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (serial.current === stamp) setLoading(false); }
  }
  return <aside ref={panel} tabIndex={-1} className="model-review-panel" aria-label="Import model draft"><header><strong>Import into draft</strong><button type="button" className="button small" onClick={onClose}>Close</button></header><div className="model-review-scroll"><p>The package is merged with your current draft. Import does not save changes to the gateway.</p><label>Model JSON file<input type="file" accept=".json,application/json" onChange={event => { void read(event.target.files?.[0]); event.target.value = ""; }} /></label><label>Model package JSON<textarea rows={16} value={text} onChange={event => { serial.current++; setLoading(false); setText(event.target.value); }} /></label>{error && <p role="alert" className="security-error">{error}</p>}</div><footer><button type="button" className="button primary" disabled={loading || !text.trim()} onClick={() => { try { onImport(text); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } }}>Merge into draft</button></footer></aside>;
}
export function ModelDiscardConfirmation({ onCancel, onConfirm, title = "Discard model draft?", description = "This removes your unsaved changes to models, machines, locations and data settings. Your saved models and equipment stay as they are." }: { onCancel: () => void; onConfirm: () => void; title?: string; description?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement; dialog.current?.showModal(); return () => { dialog.current?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); }; }, []);
  return <dialog className="project-dialog" ref={dialog} aria-labelledby="model-discard-title" onCancel={event => { event.preventDefault(); onCancel(); }}><header><h2 id="model-discard-title">{title}</h2></header><div className="project-dialog-body"><p>{description}</p></div><footer><button type="button" className="button" onClick={onCancel}>Keep editing</button><button type="button" className="button danger" onClick={onConfirm}>Discard draft</button></footer></dialog>;
}
