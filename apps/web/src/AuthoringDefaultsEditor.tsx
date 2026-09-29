import { useEffect, useState } from "react";
import { authoringDefaultsError, projectAuthoringDefaults } from "./authoringDefaults";
import type { AuthoringDefaults } from "./authoringDefaults";
import "./authoringDefaults.css";

const labels: [keyof AuthoringDefaults, string][] = [["screenWidth", "New screen width"], ["screenHeight", "New screen height"], ["templateWidth", "New template width"], ["templateHeight", "New template height"], ["gridSize", "Default grid size"]];
const draftOf = (value?: AuthoringDefaults) => Object.fromEntries(Object.entries(projectAuthoringDefaults({ authoringDefaults: value })).map(([key, number]) => [key, String(number)])) as Record<keyof AuthoringDefaults, string>;

export function AuthoringDefaultsEditor({ value, onApply }: { value?: AuthoringDefaults; onApply: (value: AuthoringDefaults) => void }) {
  const [draft, setDraft] = useState(() => draftOf(value));
  const [message, setMessage] = useState("");
  const saved = JSON.stringify(value);
  useEffect(() => { setDraft(draftOf(value)); setMessage(""); }, [saved]); // Reset when the saved draft changes through Undo or project selection.
  const proposed = Object.fromEntries(Object.entries(draft).map(([key, text]) => [key, /^\d+$/.test(text.trim()) ? Number(text) : NaN])) as unknown as AuthoringDefaults;
  const error = authoringDefaultsError(proposed);
  const changed = JSON.stringify(draft) !== JSON.stringify(draftOf(value));
  return <section className="document-property-group authoring-defaults" aria-label="Canvas authoring defaults">
    <h3>Canvas authoring defaults</h3>
    <p className="document-property-help">Starting sizes for new screens and templates. Existing documents keep their current dimensions. The grid is used when this project opens; you can override it in the canvas toolbar. Zero disables snapping.</p>
    <div className="authoring-defaults-fields">{labels.map(([key, label]) => <label key={key}><span>{label}</span><div><input type="number" aria-label={label} min={key === "gridSize" ? 0 : 1} max={key === "gridSize" ? 128 : 8192} step={1} value={draft[key]} onChange={event => { setDraft({ ...draft, [key]: event.target.value }); setMessage(""); }} /><span>px</span></div></label>)}</div>
    {changed && error && <p role="alert">{error}</p>}
    <div className="authoring-defaults-actions"><button type="button" className="button small" disabled={!changed} onClick={() => { setDraft(draftOf(value)); setMessage("Changes canceled."); }}>Cancel defaults changes</button><button type="button" className="button small primary" disabled={!changed || Boolean(error)} onClick={() => { if (!error) { onApply(proposed); setMessage("Authoring defaults applied to the draft. Save the project to keep them."); } }}>Apply defaults</button></div>
    {message && <p className="document-property-help" role="status">{message}</p>}
  </section>;
}
