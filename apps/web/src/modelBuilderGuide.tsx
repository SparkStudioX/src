import { useState } from "react";
type Props = { hasModel: boolean; hasFields: boolean; equipmentCount: number; sourcesReady: boolean; hasChanges: boolean; disabled?: boolean; onFields: () => void; onEquipment: () => void; onSources: () => void; onReview?: () => void; onVerify?: () => void };
const storageKey = "sparkstudio.model-builder-guide-hidden";
export default function ModelBuilderGuide(props: Props) {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(storageKey) === "true"; } catch { return false; } });
  function visibility(next: boolean) { setHidden(next); try { localStorage.setItem(storageKey, String(next)); } catch { /* The guide still works without browser storage. */ } }
  if (hidden) return <button type="button" className="button small model-guide-show" onClick={() => visibility(false)}>Show setup guide</button>;
  const steps = [
    { label: "Define fields", hint: "Choose the values your model needs.", done: props.hasFields, run: props.onFields, disabled: false },
    { label: "Add equipment", hint: "Use the model for a real machine.", done: props.equipmentCount > 0, run: props.onEquipment, disabled: !props.hasModel },
    { label: "Connect sources", hint: "Check where each machine gets its data.", done: props.sourcesReady, run: props.onSources, disabled: !props.equipmentCount },
    { label: "Review changes", hint: "Apply your draft together when ready.", done: props.hasModel && props.equipmentCount > 0 && !props.hasChanges, run: props.onReview, disabled: !props.hasChanges },
    { label: "Verify live values", hint: "Inspect saved equipment and its quality.", done: false, run: props.onVerify, disabled: props.hasChanges || !props.equipmentCount },
  ];
  return <section className="model-setup-guide" aria-label="Model setup guide"><header><strong>Your next steps</strong><span>You can jump between steps. Nothing goes live until you apply.</span><button type="button" className="button small" onClick={() => visibility(true)} aria-label="Hide setup guide">Hide guide</button></header>
    <ol>{steps.map((step, index) => <li key={step.label} className={step.done ? "complete" : ""}><button type="button" title={step.hint} disabled={props.disabled || step.disabled || !step.run} onClick={step.run}><span className="model-guide-number" aria-label={step.done ? "Complete" : `Step ${index + 1}`}>{step.done ? "✓" : index + 1}</span><span><strong>{step.label}</strong><small>{step.hint}</small></span></button></li>)}</ol>
  </section>;
}
