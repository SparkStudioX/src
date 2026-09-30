import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import type { Publication } from "./types";
import "./publicationHistory.css";

interface Review {
  reviewToken: string; revision: number; scriptsRevision: number; name: string;
  screens: number; templates: number; queries: number; warnings?: string[];
  resources: { name: string; type: string; event?: string; enabled: boolean }[];
}
export default function ApplicationPublishDialog({ projectRevision, scriptsRevision, onClose, onPublished }: {
  projectRevision?: number; scriptsRevision?: number; onClose: () => void; onPublished: (publication: Publication) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function load() {
    setBusy(true); setError(""); setReview(null);
    try {
      const next = await api<Review>("/project/publication-review");
      if (projectRevision !== undefined && next.revision !== projectRevision || scriptsRevision !== undefined && next.scriptsRevision !== scriptsRevision)
        throw new Error("Saved drafts changed since this workspace loaded. Close this review and reload the workspace before publishing.");
      setReview(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  useEffect(() => { const element = dialog.current; element?.showModal(); void load(); return () => element?.close(); }, []);
  async function publish() {
    if (!review || busy) return;
    setBusy(true); setError("");
    try {
      const publication = await api<Publication>("/project/publish", "POST", { revision: review.revision, scriptsRevision: review.scriptsRevision, reviewToken: review.reviewToken });
      onPublished(publication);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setReview(null); }
    finally { setBusy(false); }
  }
  return createPortal(<dialog className="publication-history-dialog" ref={dialog} aria-labelledby="application-publish-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id="application-publish-title">Review application publication</h2><p>Publish the saved screens, queries and script resources together as one application version.</p></header>
    <div className="publication-history-body">
      {error && <p role="alert">{error}</p>}
      {!review && <p>{busy ? "Loading saved application…" : "Refresh the review to see the latest saved application."}</p>}
      {review && <><h3>{review.name}</h3><p>Project revision {review.revision} · Scripts revision {review.scriptsRevision}</p>
        <p>{review.screens} screens and popups · {review.templates} templates · {review.queries} named queries · {review.resources.length} script resources</p>
        {review.resources.length > 0 && <table><thead><tr><th>Resource</th><th>Kind</th><th>After publication</th></tr></thead><tbody>{review.resources.map((resource, index) => <tr key={index}><td>{resource.name}</td><td>{resource.type}{resource.event ? ` / ${resource.event}` : ""}</td><td>{resource.enabled ? "Enabled" : "Disabled"}</td></tr>)}</tbody></table>}
        <p>Enabled gateway events activate after the previous event generation stops. Browser scripts load with their matching operator application version. Open operator sessions must load the new version.</p>
        <p>Executable JavaScript and Python changes require a gateway administrator. Python runs as the service account; browser scripts have application-origin privileges and synchronous loops can freeze a tab. Publish only code you trust.</p>
        <p>Only saved drafts are included. Unsaved work in other tabs remains in those tabs. Tags, connection settings and database data are outside this publication.</p>
        {review.warnings?.map((warning, index) => <p key={index} role="note">{warning}</p>)}
      </>}
    </div><footer><button className="button" disabled={busy} onClick={() => void load()}>Refresh review</button><button className="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !review} onClick={() => void publish()}>{busy ? "Working…" : "Publish application"}</button></footer>
  </dialog>, document.body);
}
