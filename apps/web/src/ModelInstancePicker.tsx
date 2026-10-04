import { useEffect, useState } from "react";
import { getModelInstances, modelChangedEvent } from "./modelApi";
import type { ModelReadInstance } from "./modelApi";
import type { ModelParameterRequirement } from "./types";
import { modelRequirementError } from "./modelParameterRules";

/** Server-filtered instances only. Unresolved imported paths remain visible as diagnostics. */
export function ModelInstancePicker({ requirement, value, onChange, disabled = false, label = "Model instance" }: {
  requirement?: ModelParameterRequirement; value: string; onChange: (path: string) => void; disabled?: boolean; label?: string;
}) {
  const [items, setItems] = useState<ModelReadInstance[]>([]), [error, setError] = useState(""), [loading, setLoading] = useState(false), [revision, setRevision] = useState(0);
  const definitionId = requirement?.definitionId, minVersion = requirement?.minVersion, maxVersion = requirement?.maxVersion;
  useEffect(() => { const refresh = () => setRevision(value => value + 1); window.addEventListener(modelChangedEvent, refresh); return () => window.removeEventListener(modelChangedEvent, refresh); }, []);
  useEffect(() => {
    const controller = new AbortController(), rule = definitionId ? { definitionId, minVersion, maxVersion } : undefined;
    setItems([]); setError(""); setLoading(false);
    if (modelRequirementError(rule)) return;
    setLoading(true);
    getModelInstances(rule, controller.signal).then(setItems).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load model instances."); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [definitionId, minVersion, maxVersion, revision]);
  return <div className="model-instance-picker">
    <select aria-label={label} value={items.some(item => item.path === value) ? value : ""} disabled={disabled || loading || !definitionId} onChange={event => { if (event.target.value) onChange(event.target.value); }}>
      <option value="">{loading ? "Loading readable instances…" : "Choose a matching instance…"}</option>
      {items.map(item => <option key={item.path} value={item.path}>{item.path} · {item.definitionId} v{item.version}</option>)}
    </select><button type="button" className="button small" disabled={disabled || loading} onClick={() => setRevision(value => value + 1)}>Refresh instances</button>
    {error && <small role="alert" className="template-parameter-error">{error}</small>}
    {!loading && !error && definitionId && !items.length && <small>No matching readable instances. The required type may need gateway setup.</small>}
    {!loading && !error && value && !value.includes("{") && !items.some(item => item.path === value) && <small role="status">The saved path is unresolved, outside the required version range, or unreadable. It is preserved for portability.</small>}
  </div>;
}
