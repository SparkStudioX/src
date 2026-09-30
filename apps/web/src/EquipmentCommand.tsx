import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useAuth } from "./Auth";
import type { CanvasComponent } from "./types";
import "./equipmentCommands.css";

export interface EquipmentCommandDefinition {
  id: string; name: string; tagPath: string; dataType: "Boolean" | "Int16" | "Int32" | "Int64" | "UInt16" | "UInt32" | "Float" | "Double" | "String";
  min?: number; max?: number; maxLength?: number; confirmation: string; readbackPath?: string; timeoutMs?: number; tolerance?: number;
}
interface Review { token: string; commandId: string; name: string; currentValue: unknown; requestedValue: unknown; confirmation: string; expiresAt: string }
interface Receipt { correlationId: string; status: string; message: string; requestedValue: unknown; observedValue: unknown }
export function commandRequestedValue(definition: EquipmentCommandDefinition, value: string | boolean): string | boolean | number {
  if (definition.dataType === "String") {
    if (typeof value !== "string") throw new Error("Enter a text value.");
    return value;
  }
  if (definition.dataType === "Boolean") {
    if (typeof value !== "boolean") throw new Error("Choose True or False.");
    return value;
  }
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Number(value))) throw new Error("Enter a finite numeric value.");
  if (/^(?:U?Int)/.test(definition.dataType) && (!/^[+-]?\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value))))
    throw new Error("Enter a whole number using digits, between −9,007,199,254,740,991 and 9,007,199,254,740,991. This browser cannot represent larger integers exactly.");
  if ((definition.dataType === "UInt16" || definition.dataType === "UInt32") && (Number(value) < 0 || Number(value) > (definition.dataType === "UInt16" ? 65535 : 4294967295))) throw new Error("Enter a value within the unsigned integer range.");
  return Number(value);
}
export function commandDefinitionError(commands: EquipmentCommandDefinition[]): string | undefined {
  if (!Array.isArray(commands) || commands.length > 128) return "At most 128 equipment commands are supported.";
  const ids = new Set<string>();
  for (const item of commands) {
    if (!item || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(item.id) || ids.has(item.id)) return "Use unique command IDs starting with a letter.";
    ids.add(item.id);
    if (!item.name?.trim() || item.name.length > 128 || !item.confirmation?.trim() || item.confirmation.length > 512) return "Each command needs a name and confirmation text.";
    if (!/^\[default\][^{}\r\n]+$/.test(item.tagPath)) return "Commands need a concrete configured tag path.";
    if (!["Boolean", "Int16", "Int32", "Int64", "UInt16", "UInt32", "Float", "Double", "String"].includes(item.dataType)) return "Choose a supported scalar type.";
    if (!["String", "Boolean"].includes(item.dataType) && (typeof item.min !== "number" || !Number.isFinite(item.min) || typeof item.max !== "number" || !Number.isFinite(item.max) || item.min > item.max)) return "Numeric commands need a valid minimum and maximum.";
  }
  return undefined;
}
export default function EquipmentCommand({ component, publishedAt, queryScope = "designer", communicationLost = false, interactionLocked = false, commit }: {
  commit?: { value: number; sequence: number };
  component: CanvasComponent; publishedAt?: string; queryScope?: "designer" | "runtime"; communicationLost?: boolean; interactionLocked?: boolean;
}) {
  const { permissions } = useAuth();
  const [definition, setDefinition] = useState<EquipmentCommandDefinition>();
  const [value, setValue] = useState<string | boolean>("");
  const [review, setReview] = useState<Review>();
  const [receipt, setReceipt] = useState<Receipt>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0), dialog = useRef<HTMLDialogElement>(null);
  const consumedCommit = useRef(-1);
  const inFlight = useRef(false), available = useRef(false), availabilityGeneration = useRef(0);
  const key = JSON.stringify([component.id, component.props.commandId, publishedAt, queryScope]);
  const canCommand = (permissions as { commands?: boolean }).commands === true;
  const allowedNow = !communicationLost && !interactionLocked && canCommand && queryScope === "runtime";
  if (available.current !== allowedNow) { available.current = allowedNow; availabilityGeneration.current++; }
  useEffect(() => {
    consumedCommit.current = commit?.sequence ?? -1;
    const run = ++generation.current; setDefinition(undefined); setReview(undefined); setReceipt(undefined); setError(""); setBusy(false); inFlight.current = false;
    if (queryScope !== "runtime" || !publishedAt) return;
    void api<EquipmentCommandDefinition[]>(`/runtime/commands?publishedAt=${encodeURIComponent(publishedAt)}`).then(commands => {
      if (generation.current !== run) return;
      const next = commands.find(command => command.id === component.props.commandId);
      setDefinition(next); setValue(next?.dataType === "Boolean" ? false : "");
      if (!next) setError("This command is not available in the published application.");
    }).catch(reason => { if (generation.current === run) setError(String(reason.message ?? reason)); });
    return () => { generation.current++; };
  }, [key]);
  useEffect(() => { if (review) dialog.current?.showModal(); return () => dialog.current?.close(); }, [review]);
  useEffect(() => { if (communicationLost || interactionLocked || !canCommand) setReview(undefined); }, [communicationLost, interactionLocked, canCommand]);
  const disabled = busy || communicationLost || interactionLocked || !canCommand || !definition || queryScope !== "runtime";
  async function prepare(committed?: number) {
    if (disabled || !definition || inFlight.current || !available.current) return;
    const run = generation.current, availability = availabilityGeneration.current;
    try {
      const requested = commandRequestedValue(definition, committed === undefined ? value : String(committed));
      inFlight.current = true;
      setBusy(true); setError(""); setReceipt(undefined);
      const next = await api<Review>(`/runtime/commands/${encodeURIComponent(definition.id)}/review`, "POST", { publishedAt, value: requested });
      if (generation.current === run && available.current && availabilityGeneration.current === availability) setReview(next);
    } catch (reason) { if (generation.current === run) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (generation.current === run) { inFlight.current = false; setBusy(false); } }
  }
  useEffect(() => {
    if (!commit || !definition || consumedCommit.current === commit.sequence) return;
    consumedCommit.current = commit.sequence;
    setValue(String(commit.value));
    void prepare(commit.value);
  }, [commit?.sequence, definition]);
  async function execute() {
    if (!review || disabled || !definition || inFlight.current || !available.current) return;
    const run = generation.current, captured = review; inFlight.current = true; setReview(undefined); setBusy(true); setError("");
    try {
      const result = await api<Receipt>(`/runtime/commands/${encodeURIComponent(definition.id)}/execute`, "POST", { token: captured.token, confirmed: true });
      if (generation.current === run) setReceipt(result);
    } catch { if (generation.current === run) setError("No command receipt was received. The target may have changed. Check its state before issuing another command."); }
    finally { if (generation.current === run) { inFlight.current = false; setBusy(false); } }
  }
  if (queryScope !== "runtime" && component.type === "numberInput") return <small>Commit reviews a configured setpoint command in the operator application.</small>;
  if (queryScope !== "runtime") return <div className="equipment-command"><strong>{component.props.text || "Equipment command"}</strong><p>Command: {component.props.commandId || "not selected"}</p><small>Review and execute from the published operator application.</small></div>;
  return <div className={`equipment-command${component.type === "numberInput" ? " equipment-command-compact" : ""}`}>{component.type !== "numberInput" && <strong>{component.props.text || definition?.name || "Equipment command"}</strong>}
    {component.type !== "numberInput" && <label>Requested value{definition?.dataType === "Boolean" ? <select value={String(value)} disabled={disabled} onChange={event => setValue(event.target.value === "true")}><option value="false">False</option><option value="true">True</option></select> : <input aria-label={`${definition?.name ?? "Command"} requested value`} type={definition?.dataType === "String" ? "text" : "number"} value={String(value)} disabled={disabled} min={definition?.min} max={definition?.max} step={/^(?:U?Int)/.test(definition?.dataType ?? "") ? 1 : "any"} maxLength={definition?.maxLength ?? 128} onChange={event => setValue(event.target.value)} />}</label>}
    <button className="button" disabled={disabled || component.type === "numberInput" && !commit} onClick={() => void prepare(component.type === "numberInput" ? commit?.value : undefined)}>{busy ? "Working…" : component.type === "numberInput" ? "Review setpoint" : "Review command"}</button>
    {!canCommand && <small>Equipment command permission is required.</small>}{communicationLost && <small>Gateway connection unavailable.</small>}
    {error && <p role="alert">{error}</p>}{receipt && <p role="status"><strong>{receipt.status}</strong> · {receipt.message}<small>Requested: {String(receipt.requestedValue)} · Readback: {receipt.observedValue == null ? "Unavailable" : String(receipt.observedValue)}<br />Reference: {receipt.correlationId}</small></p>}
    {review && <dialog ref={dialog} className="project-dialog command-confirmation" onCancel={() => setReview(undefined)} onKeyDown={event => event.stopPropagation()}><header><h2>{review.name}</h2></header><div className="project-dialog-body"><p>{review.confirmation}</p><dl><dt>Current value</dt><dd>{String(review.currentValue)}</dd><dt>Requested value</dt><dd>{String(review.requestedValue)}</dd></dl><p>Confirmation expires in 30 seconds. A changed value or configuration requires a new review.</p></div><footer><button className="button" autoFocus onClick={() => setReview(undefined)}>Cancel</button><button className="button primary" disabled={disabled} onClick={() => void execute()}>Confirm command</button></footer></dialog>}
  </div>;
}
