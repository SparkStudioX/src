import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import type { Connection } from "./types";
import type { ModelPackage } from "./modelWorkspace";
import { ModelIssuesPanel, ModelLiveObjectPanel } from "./modelIssuesPanel";
import { ModelVersionPanel } from "./modelVersionPanel";
import { ModelMappingPanel } from "./modelMappingPanel";
import { ModelDependencyPanel, ModelSelectiveExportPanel } from "./modelDependencyPanel";
import { ModelStarterPanel } from "./modelStarterPanel";
import { ModelPublishingPanel } from "./modelPublishingPanel";
import "./modelOperations.css";

const groups = [
  { name: "Check", description: "See values and fix data issues", tools: [["live", "Live values"], ["issues", "Data issues"]] },
  { name: "Manage", description: "Maintain models and their sources", tools: [["versions", "Versions"], ["mappings", "Source mappings"], ["dependencies", "Dependencies"]] },
  { name: "Share", description: "Send data or reuse your setup", tools: [["publish", "Publish MQTT"], ["export", "Export selection"]] },
] as const;
export type ModelOperationTool = typeof groups[number]["tools"][number][0] | "start";
const knownTool = (value: string | null): value is ModelOperationTool => value === "start" || groups.some(group => group.tools.some(([key]) => key === value));
function rememberTool(tool: ModelOperationTool) { const url = new URL(window.location.href); url.searchParams.set("tool", tool); window.history.replaceState(window.history.state, "", url); }
export default function ModelOperationsPanel({ model, savedModel, onChange, connections, tagPaths, onNavigate, onSelect, onLockChange, requestedTool }: { model: ModelPackage; savedModel: ModelPackage; onChange: (model: ModelPackage) => void; connections: Connection[]; tagPaths: string[]; onNavigate: (path: string) => void; onSelect: (key: string) => void; onLockChange: (locked: boolean) => void; requestedTool?: { tool: ModelOperationTool; requestId: number; equipmentPath?: string } }) {
  const [tab, setTab] = useState<ModelOperationTool>(() => { const value = new URLSearchParams(window.location.search).get("tool"); return requestedTool?.tool || (knownTool(value) ? value : "live"); });
  const [locked, setLocked] = useState(false);
  const handledRequest = useRef<number | undefined>(undefined);
  const lock = useCallback((value: boolean) => { setLocked(value); onLockChange(value); }, [onLockChange]);
  useEffect(() => { if (requestedTool && !locked && handledRequest.current !== requestedTool.requestId) { handledRequest.current = requestedTool.requestId; setTab(requestedTool.tool); rememberTool(requestedTool.tool); } }, [requestedTool, locked]);
  function select(next: ModelOperationTool) { if (locked && next !== tab) return; setTab(next); rememberTool(next); }
  return <div className="model-operations">
    <section className="model-operation-navigation" aria-label="Check and share models">
      <header><div><h2>Model tools</h2><p>Check your data, manage model versions, or share equipment values.</p></div><button type="button" className={`button model-starter-action${tab === "start" ? " active" : ""}`} disabled={locked && tab !== "start"} aria-pressed={tab === "start"} onClick={() => select("start")}><Icon name="layers" size={16} />Use a starter</button></header>
      <nav aria-label="Model tools" className="model-operation-tabs">{groups.map(group => <section className="model-operation-group" key={group.name}><h3 title={group.description}>{group.name}</h3><div className="model-operation-choices">{group.tools.map(([key, label]) => <button type="button" key={key} disabled={locked && tab !== key} className={tab === key ? "active" : ""} aria-pressed={tab === key} onClick={() => select(key)}>{label}</button>)}</div></section>)}</nav>
      {locked && <p className="model-operation-lock" role="status">Save or discard publisher edits before switching tools.</p>}
    </section>
    <div className="model-operation-content">{tab === "issues" && <ModelIssuesPanel model={savedModel} onNavigate={onNavigate} initialEquipment={requestedTool?.equipmentPath} />}{tab === "live" && <ModelLiveObjectPanel model={savedModel} initialEquipment={requestedTool?.equipmentPath} />}{tab === "mappings" && <ModelMappingPanel model={model} onChange={onChange} connections={connections} tagPaths={tagPaths} />}{tab === "versions" && <ModelVersionPanel model={model} onChange={onChange} />}{tab === "publish" && <ModelPublishingPanel model={savedModel} onLockChange={lock} />}{tab === "dependencies" && <ModelDependencyPanel model={savedModel} />}{tab === "export" && <ModelSelectiveExportPanel model={savedModel} />}{tab === "start" && <ModelStarterPanel model={model} onChange={onChange} onSelect={onSelect} />}</div>
  </div>;
}
