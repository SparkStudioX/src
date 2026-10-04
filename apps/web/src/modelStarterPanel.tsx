import { useEffect, useState } from "react";
import { getModelStarters, modelErrorText, type ModelStarter } from "./modelOperationsApi";
import { definitionKey, type ModelPackage } from "./modelWorkspace";

export function ModelStarterPanel({ model, onChange, onSelect }: { model: ModelPackage; onChange: (model: ModelPackage) => void; onSelect: (key: string) => void }) {
  const [starters, setStarters] = useState<ModelStarter[]>([]), [error, setError] = useState(""), [selected, setSelected] = useState<string>("");
  useEffect(() => { let active = true; void getModelStarters().then(result => { if (active) setStarters(result.items); }).catch(reason => { if (active) setError(modelErrorText(reason)); }); return () => { active = false; }; }, []);
  function add(starter: ModelStarter) { const definition = structuredClone(starter.definition); let suffix = 2; while (model.udtDefinitions.some(item => item.id === definition.id)) definition.id = `${starter.definition.id}${suffix++}`; definition.version = 1; onChange({ ...model, udtDefinitions: [...model.udtDefinitions, definition] }); onSelect(definitionKey(definition)); }
  const guide = starters.find(item => item.id === selected);
  return <section className="model-operation-panel"><h2>Start with a working example</h2><p>These independently authored examples use local demo values. Add one to your draft, explore its behavior, then map it to your real data.</p>{error && <p className="security-error" role="alert">{error}</p>}<div className="model-starter-grid">{starters.map(starter => <article className="model-card" key={starter.id}><h3>{starter.name}</h3><p>{starter.description}</p><p>{starter.definition.members.length} fields</p><div className="model-actions"><button type="button" className="button primary" onClick={() => add(starter)}>Use {starter.name}</button><button type="button" className="button" onClick={() => setSelected(starter.id)}>Walkthrough</button></div></article>)}</div>{guide && <section className="model-card"><h3>{guide.name} walkthrough</h3><ol>{guide.walkthrough.map((text, index) => <li key={index}>{text}</li>)}</ol></section>}</section>;
}
