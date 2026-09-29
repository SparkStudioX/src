import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { createPortal } from "react-dom";
import "./publicationHistory.css";
interface Entry { id: string; name: string; revision: number; recordedAt: string; publishedAt: string; current: boolean }
interface History { current: { published: boolean; publishedAt?: string; revision?: number }; scope: string; retention: number; entries: Entry[]; warnings?: string[] }
export default function PublicationHistoryDialog({ canPublish, onClose, onRestored }: { canPublish: boolean; onClose: () => void; onRestored: () => void }) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [history,setHistory]=useState<History|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[selected,setSelected]=useState<Entry|null>(null);
  async function load() { setBusy(true);setError("");setSelected(null); try{setHistory(await api<History>("/project/history"));}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);} }
  useEffect(()=>{const element=dialog.current; element?.showModal();void load();return()=>element?.close();},[]);
  async function restore() {
    if(!selected || !history?.current.publishedAt)return;
    setBusy(true);setError("");
    try{await api(`/project/history/${selected.id}/restore`,"POST",{expectedPublishedAt:history.current.publishedAt});onRestored();await load();}
    catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  return createPortal(<dialog className="publication-history-dialog" ref={dialog} aria-labelledby="publication-history-title" onCancel={event=>{event.preventDefault();if(!busy)onClose();}} onKeyDown={event=>event.stopPropagation()}>
    <header><h2 id="publication-history-title">Publication history</h2><p>Restore an operator application snapshot without changing your saved or unsaved Designer drafts.</p></header>
    <div className="publication-history-body">
      {error&&<p role="alert">{error}</p>}{!history&&<p>{busy?"Loading history…":"History unavailable. Try refreshing."}</p>}
      {history&&<><p>{history.scope}</p><p>Retains up to {history.retention} snapshots on this gateway. History starts with publications made by this version; project exports contain drafts only.</p>
        {Boolean(history.warnings?.length)&&<section className="publication-restore-review" role="alert" aria-label="Publication history retention notice"><h3>History retention notice</h3><ul>{history.warnings!.map((warning,index)=><li key={index}>{warning}</li>)}</ul></section>}
        {!history.entries.length?<p>No snapshots have been recorded. Save and publish this project to begin its history.</p>:<table><thead><tr><th>Version</th><th>Published</th><th>Status</th><th>Action</th></tr></thead><tbody>{history.entries.map(entry=><tr key={entry.id}><td>{entry.name}<br/>Revision {entry.revision}</td><td>{new Date(entry.publishedAt).toLocaleString()}</td><td>{entry.current?"Current":"Previous"}</td><td><button type="button" className="button" disabled={busy||!canPublish||entry.current} onClick={()=>setSelected(entry)}>Review restore</button></td></tr>)}</tbody></table>}
        {selected&&<section className="publication-restore-review" aria-label="Review publication restore"><h3>Restore revision {selected.revision}?</h3><p>This immediately replaces the operator publication with the selected screens, button code and query definitions. Open operator sessions must load the new version before their next action. Designer drafts stay unchanged.</p><p><strong>Script libraries, gateway event scripts, tags, connection settings and database data are not restored.</strong> Check that the selected snapshot is compatible with the currently published libraries.</p><button className="button" disabled={busy} onClick={()=>setSelected(null)}>Cancel restore</button><button className="button primary" disabled={busy||!canPublish} onClick={()=>void restore()}>Restore operator publication</button></section>}
      </>}
    </div><footer><button className="button" disabled={busy} onClick={()=>void load()}>Refresh history</button><button className="button" disabled={busy} onClick={onClose}>Close</button></footer>
  </dialog>,document.body);
}
