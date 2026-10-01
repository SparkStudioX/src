import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import type { Publication } from "./types";
import "./publicationHistory.css";
import "./applicationPublish.css";

interface Review {
  reviewToken: string; revision: number; scriptsRevision: number; name: string;
  screens: number; templates: number; queries: number; warnings?: string[];
  requiresScriptApproval?: boolean;
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
  return createPortal(<dialog className="publication-history-dialog application-publish-dialog" ref={dialog} aria-labelledby="application-publish-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id="application-publish-title">Review application publication</h2><p>Publish the saved screens, queries and script resources together as one application version.</p></header>
    <div className="publication-history-body">
      {error && <p className="application-publish-error" role="alert">{error}</p>}
      {!review && <p>{busy ? "Loading saved application…" : "Refresh the review to see the latest saved application."}</p>}
      {review && <>
        <section className="application-publish-summary" aria-labelledby="application-publish-project">
          <h3 id="application-publish-project">{review.name}</h3>
          <p className="application-publish-revision">Project revision {review.revision} · Scripts revision {review.scriptsRevision}</p>
          <dl className="application-publish-counts">
            <div><dt>Screens and popups</dt><dd>{review.screens}</dd></div>
            <div><dt>Templates</dt><dd>{review.templates}</dd></div>
            <div><dt>Named queries</dt><dd>{review.queries}</dd></div>
            <div><dt>Script resources</dt><dd>{review.resources.length}</dd></div>
          </dl>
        </section>
        <section className="application-publish-impact" aria-labelledby="application-publish-impact">
          <h3 id="application-publish-impact">Operators will receive a new application version</h3>
          <p>Open operator sessions must load the new version to use it.</p>
          <p className="application-publish-secondary">Enabled gateway events activate after the previous event generation stops. Browser scripts load with their matching application version.</p>
        </section>
        <section className="application-publish-scope" aria-labelledby="application-publish-scope">
          <h3 id="application-publish-scope">Only saved drafts are included</h3>
          <p className="application-publish-secondary">Unsaved work in other tabs stays in those tabs. Gateway tags, connections and database data are not part of this publication.</p>
        </section>
        {review.resources.length > 0 && <details className="application-publish-details"><summary>Review {review.resources.length} script resources</summary><div className="application-publish-table"><table><thead><tr><th>Resource</th><th>Kind</th><th>After publication</th></tr></thead><tbody>{review.resources.map((resource, index) => <tr key={index}><td>{resource.name}</td><td>{resource.type}{resource.event ? ` / ${resource.event}` : ""}</td><td>{resource.enabled ? "Enabled" : "Disabled"}</td></tr>)}</tbody></table></div></details>}
        {(review.requiresScriptApproval || review.resources.length > 0) && <details className="application-publish-details" open={review.requiresScriptApproval || undefined}>
          <summary>{review.requiresScriptApproval ? "Script changes require a gateway administrator" : "Script execution permissions"}</summary>
          <p>Publish only code you trust. Python runs as the gateway service account. Browser JavaScript has application-origin privileges; synchronous loops can freeze an operator tab.</p>
        </details>}
        {Boolean(review.warnings?.length) && <section className="application-publish-notices" aria-labelledby="application-publish-notices"><h3 id="application-publish-notices">Publication notices</h3><ul>{review.warnings!.map((warning, index) => <li key={index}>{warning}</li>)}</ul></section>}
      </>}
    </div><footer><button className="button" disabled={busy} onClick={() => void load()}>Refresh review</button><button className="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !review} onClick={() => void publish()}>{busy ? "Working…" : "Publish application"}</button></footer>
  </dialog>, document.body);
}
