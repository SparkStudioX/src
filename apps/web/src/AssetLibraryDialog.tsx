import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiUrl } from "./api";
import { planAssetReplacement, projectAssetUses } from "./assetLibrary";
import type { AssetReplacementPlan, AssetUse } from "./assetLibrary";
import type { Asset, Project } from "./types";
import "./assetLibrary.css";

const pageSize = 100;
export default function AssetLibraryDialog({ project, assets, onApply, onClose, onOpenReference }: {
  project: Project; assets: Asset[];
  onApply: (plan: AssetReplacementPlan, selectedUseIds: string[]) => void;
  onClose: () => void;
  onOpenReference?: (use: AssetUse) => void;
}) {
  const id = useId(), dialog = useRef<HTMLDialogElement>(null), searchInput = useRef<HTMLInputElement>(null), applying = useRef(false);
  const [search, setSearch] = useState(""), [sourceId, setSourceId] = useState(""), [replacementId, setReplacementId] = useState("");
  const [plan, setPlan] = useState<AssetReplacementPlan | null>(null), [selection, setSelection] = useState<Set<string>>(new Set()), [page, setPage] = useState(0), [error, setError] = useState("");
  const uses = useMemo(() => projectAssetUses(project), [project]);
  const inventory = useMemo(() => {
    const result = assets.map(asset => ({ ...asset, missing: false }));
    for (const use of uses) if (!result.some(asset => asset.id === use.assetId)) result.push({ id: use.assetId, name: "Unavailable image", size: 0, width: 0, height: 0, contentType: "", missing: true });
    return result.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }, [assets, uses]);
  const filtered = inventory.filter(asset => [asset.name, asset.id, ...uses.filter(use => use.assetId === asset.id).map(use => use.location)].join(" ").toLowerCase().includes(search.toLowerCase()));
  const current = inventory.find(asset => asset.id === sourceId), replacement = assets.find(asset => asset.id === replacementId);
  const sourceUses = uses.filter(use => use.assetId === sourceId);
  const visibleUses = plan?.uses.slice(page * pageSize, (page + 1) * pageSize) ?? sourceUses.slice(0, pageSize);
  const pages = Math.max(1, Math.ceil((plan?.uses.length ?? 0) / pageSize));
  const selectedElsewhere = selection.size - visibleUses.filter(use => selection.has(use.id)).length;
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement;
    element?.showModal(); searchInput.current?.focus();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const clearPlan = () => { setPlan(null); setSelection(new Set()); setPage(0); setError(""); };
  const preview = () => {
    const next = planAssetReplacement(project, assets, sourceId, replacementId);
    setPlan(next); setError(""); setPage(0);
    setSelection(new Set(next.errors.length ? [] : next.uses.slice(0, pageSize).map(use => use.id)));
  };
  const nameOf = (assetId: string) => inventory.find(asset => asset.id === assetId)?.name ?? "Unavailable image";
  return createPortal(<dialog ref={dialog} className="asset-library-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-help`} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && ["s", "h"].includes(event.key.toLowerCase())) event.preventDefault(); }}>
    <header><div><div className="eyebrow">{project.name}</div><h2 id={`${id}-title`}>Asset library</h2></div><button type="button" aria-label="Close asset library" onClick={onClose}>×</button></header>
    <p id={`${id}-help`}>Search local images and inspect their structured uses. Replacing selected uses changes the draft only. Existing image files are retained for published applications.</p>
    <div className="asset-library-body">
      <section className="asset-library-inventory" aria-label="Local image library">
        <label>Search images<input ref={searchInput} aria-label="Search images" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, ID, or usage location" /></label>
        <p>{filtered.length} of {inventory.length} images</p>
        <div className="asset-library-items">{filtered.map(asset => <button type="button" key={asset.id} className={asset.id === sourceId ? "selected" : ""} aria-pressed={asset.id === sourceId} aria-label={`Inspect ${asset.name} ${asset.id.slice(0, 8)}`} onClick={() => { setSourceId(asset.id); if (asset.id === replacementId) setReplacementId(""); clearPlan(); }}>
          {!asset.missing ? <img loading="lazy" src={apiUrl(`/assets/${asset.id}`)} alt="" /> : <span className="asset-library-missing">Missing</span>}
          <span><strong>{asset.name}</strong><small>{asset.missing ? "Not in current local library" : `${asset.width} × ${asset.height} · ${(asset.size / 1024).toFixed(1)} KiB`}</small><small>{uses.filter(use => use.assetId === asset.id).length} structured uses · {asset.id.slice(0, 12)}</small></span>
        </button>)}</div>
        {!filtered.length && <p>No images match. Upload images using an image component's property sheet.</p>}
      </section>
      <section className="asset-library-detail" aria-label="Image usage and replacement">
        {!current ? <p>Choose an image to inspect its uses across screens and templates.</p> : <>
          <h3>{current.name}</h3><code className="asset-library-id">{current.id}</code>
          <p>{sourceUses.length} image components reference this asset. Shared templates appear once per definition.</p>
          <label>Replacement image<select aria-label="Replacement image" value={replacementId} onChange={event => { setReplacementId(event.target.value); clearPlan(); }}><option value="">Choose a different local image…</option>{assets.filter(asset => asset.id !== sourceId).map(asset => <option key={asset.id} value={asset.id}>{asset.name} · {asset.id.slice(0, 8)}</option>)}</select></label>
          {replacement && <div className="asset-library-comparison"><div><span>Before · {current.name}</span>{!current.missing && <img src={apiUrl(`/assets/${sourceId}`)} alt="Source image preview" />}</div><div><span>After · {replacement.name}</span><img src={apiUrl(`/assets/${replacementId}`)} alt="Replacement image preview" /></div></div>}
          <button type="button" className="button small" disabled={!replacementId || !sourceUses.length} onClick={preview}>{plan ? "Refresh replacement preview" : "Preview image replacement"}</button>
          {plan?.errors.map(message => <p role="alert" key={message}>{message}</p>)}
          {error && <p role="alert">{error}</p>}
          {plan && !plan.errors.length && <div className="asset-library-selection"><span>{selection.size} of {plan.uses.length} uses selected{selectedElsewhere > 0 ? ` · ${selectedElsewhere} on other pages` : ""}</span><button type="button" className="button small" onClick={() => setSelection(new Set(plan.uses.map(use => use.id)))}>Select all {plan.uses.length} uses</button><button type="button" className="button small" onClick={() => setSelection(new Set())}>Clear selection</button></div>}
          <div className="asset-library-uses" aria-label={plan ? "Replacement preview" : "Structured image uses"}>{visibleUses.map(use => <div key={use.id} className="asset-library-use">
            {plan && !plan.errors.length && <input type="checkbox" aria-label={`Replace image in ${use.location}`} checked={selection.has(use.id)} onChange={event => setSelection(currentSelection => { const next = new Set(currentSelection); if (event.target.checked) next.add(use.id); else next.delete(use.id); return next; })} />}
            <div><strong>{use.location}</strong><span>{plan ? `${nameOf(sourceId)} → ${nameOf(replacementId)}` : "Saved image reference"}</span><small>Alt text: {use.alt || "(empty)"} · Position, size, bindings and alt text stay unchanged.</small></div>
            {onOpenReference && <button type="button" className="button small" aria-label={`Open ${use.location}`} onClick={() => { onClose(); onOpenReference(use); }}>Open</button>}
          </div>)}</div>
          {!plan && sourceUses.length > pageSize && <p>Showing the first {pageSize} uses. Preview a replacement to page through all uses.</p>}
          {plan && pages > 1 && <div className="asset-library-pages"><button type="button" className="button small" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous uses</button><span>Page {page + 1} of {pages}</span><button type="button" className="button small" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next uses</button></div>}
        </>}
      </section>
    </div>
    <footer><span>Save and publish separately. Undo restores a replacement batch.</span><button type="button" className="button" onClick={onClose}>Cancel</button><button type="button" className="button primary" disabled={!plan || plan.errors.length > 0 || !selection.size || Boolean(error)} onClick={() => {
      if (!plan || applying.current) return;
      applying.current = true;
      try { onApply(plan, [...selection]); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { applying.current = false; }
    }}>Apply {selection.size} selected uses</button></footer>
  </dialog>, document.body);
}
