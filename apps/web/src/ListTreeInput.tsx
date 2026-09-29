import { useEffect, useId, useRef, useState } from "react";
import { querySelectionChanges } from "./queryOptions";
import { useQueryOptions } from "./useQueryOptions";
import { treeAncestors, validateListTreeOptions, visibleTreeOptions } from "./listTreeModel";
import type { ListTreeOption } from "./listTreeModel";
import type { QueryOption } from "./queryOptions";
import type { CanvasComponent, InputValue, InputValues, RuntimeParameters } from "./types";
import "./listTree.css";

interface ListTreeProps {
  component: CanvasComponent;
  components: CanvasComponent[];
  label: string;
  value: InputValue | null;
  inputs: InputValues;
  parameters: RuntimeParameters;
  queryScope: "designer" | "runtime";
  publishedAt?: string;
  communicationLost: boolean;
  disabled: boolean;
  tabIndex: number;
  onChange: (value: InputValue) => void;
  onMappedChange?: (field: string, value: InputValue) => void;
}

/** Query/static forms share selection, tree expansion and keyboard behavior. */
export default function ListTreeInput(props: ListTreeProps) {
  if (props.component.props.optionsSource) return <QueryListTreeInput {...props} />;
  let options: ListTreeOption[] = [], error = "";
  try { options = validateListTreeOptions(props.component.type as "list" | "treeView", props.component.props.options); }
  catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  return <ChoiceCollection {...props} options={options} error={error} loading={false}
    contextKey={JSON.stringify([props.component.id, props.component.type, props.parameters, options])}
    onChoose={option => props.onChange(option.value)} />;
}

function QueryListTreeInput(props: ListTreeProps) {
  const source = props.component.props.optionsSource!;
  const configurationError = props.component.type === "treeView" && !source.parentColumn ? "Choose a parent column for the tree options query."
    : props.component.type === "list" && source.parentColumn !== undefined ? "List options do not use a parent column." : "";
  const state = useQueryOptions(source, props.queryScope, props.parameters, props.communicationLost || Boolean(configurationError), props.publishedAt);
  const [selectionError, setSelectionError] = useState<{ key: string; message: string } | null>(null);
  const context = JSON.stringify([state.key, props.value, props.component.props.selectionFields, props.disabled, props.inputs, props.components]);
  const latest = useRef(context), mounted = useRef(true);
  latest.current = context;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const error = configurationError || state.error || (selectionError?.key === state.key ? selectionError.message : "");
  const choose = (option: ListTreeOption) => {
    if (props.disabled || props.communicationLost || state.loading || state.error || configurationError) return;
    const current = state.options.find(item => item.value === option.value);
    if (current) apply(current);
  };
  const apply = (option: QueryOption) => {
    try {
      const changes = querySelectionChanges(option, props.component, props.components);
      for (const [field, value] of changes) props.onMappedChange?.(field, value);
      setSelectionError(null); props.onChange(option.value);
    } catch (reason) { setSelectionError({ key: state.key, message: reason instanceof Error ? reason.message : String(reason) }); }
  };
  const reload = Object.keys(props.component.props.selectionFields ?? {}).length ? async () => {
    if (props.disabled || props.communicationLost || state.loading || state.error || configurationError) return;
    const options = await state.refresh();
    if (!options || !mounted.current || latest.current !== context) return;
    const selected = options.find(option => option.value === props.value);
    if (!selected) { setSelectionError({ key: state.key, message: "This selection is no longer available. Choose another record." }); return; }
    apply(selected);
  } : undefined;
  return <ChoiceCollection {...props} options={state.options} error={error} loading={state.loading}
    disabled={props.disabled || props.communicationLost || Boolean(configurationError)} blocked={Boolean(configurationError || state.error)} contextKey={state.key} onChoose={choose} onReload={reload} />;
}

interface ChoiceProps extends ListTreeProps {
  options: readonly ListTreeOption[];
  error: string;
  blocked?: boolean;
  loading: boolean;
  contextKey: string;
  onChoose: (option: ListTreeOption) => void;
  onReload?: () => Promise<void>;
}

export function ChoiceCollection(props: ChoiceProps) {
  const statusId = useId(), container = useRef<HTMLDivElement>(null);
  const tree = props.component.type === "treeView";
  const key = JSON.stringify([props.contextKey, props.options.map(option => [option.value, option.label, option.parentValue])]);
  const [expandedState, setExpanded] = useState<{ key: string; values: Set<string> }>({ key: "", values: new Set() });
  const [focusState, setFocus] = useState<{ key: string; value: string }>({ key: "", value: "" });
  const typeahead = useRef({ key: "", text: "", time: 0 });
  const expanded = expandedState.key === key ? expandedState.values : treeAncestors(props.options, typeof props.value === "string" ? props.value : null);
  const visible = tree ? visibleTreeOptions(props.options, expanded) : props.options.map((option, index) => ({ option, depth: 1, hasChildren: false, position: index + 1, siblings: props.options.length }));
  const selected = props.options.find(option => option.value === props.value);
  const focused = visible.find(item => item.option.value === (focusState.key === key ? focusState.value : props.value)) ?? visible[0];
  const disabled = props.disabled || props.loading || (props.blocked ?? Boolean(props.error)) || !props.options.length;
  const status = props.error || (props.loading ? "Loading options…" : !props.options.length ? "No options returned" : !selected
    ? props.value !== null && props.value !== "" ? "Selection no longer available" : "Choose a value…"
    : `${props.options.length} ${tree ? "nodes" : "choices"}`);
  const optionId = (value: string) => `${statusId}-node-${props.options.findIndex(option => option.value === value)}`;
  const focus = (value: string) => setFocus({ key, value });
  const toggle = (value: string, open?: boolean) => {
    const next = new Set(expanded);
    if (open ?? !next.has(value)) next.add(value); else next.delete(value);
    setExpanded({ key, values: next });
  };
  const choose = (option: ListTreeOption) => { if (!disabled) { focus(option.value); props.onChoose(option); } };
  const keyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !focused) return;
    const index = visible.indexOf(focused);
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", ...(tree ? ["ArrowLeft", "ArrowRight"] : [])].includes(event.key)) event.preventDefault();
    if (event.key === "ArrowDown") focus(visible[Math.min(visible.length - 1, index + 1)].option.value);
    else if (event.key === "ArrowUp") focus(visible[Math.max(0, index - 1)].option.value);
    else if (event.key === "Home") focus(visible[0].option.value);
    else if (event.key === "End") focus(visible.at(-1)!.option.value);
    else if (event.key === "Enter" || event.key === " ") choose(focused.option);
    else if (tree && event.key === "ArrowRight" && focused.hasChildren) {
      if (!expanded.has(focused.option.value)) toggle(focused.option.value, true); else focus(visible[index + 1].option.value);
    } else if (tree && event.key === "ArrowLeft") {
      if (focused.hasChildren && expanded.has(focused.option.value)) toggle(focused.option.value, false);
      else if (focused.option.parentValue) focus(focused.option.parentValue);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== " ") {
      const now = Date.now(), previous = typeahead.current;
      const text = previous.key === key && now - previous.time < 800 ? previous.text + event.key.toLowerCase() : event.key.toLowerCase();
      typeahead.current = { key, time: now, text };
      const candidates = [...visible.slice(index + 1), ...visible.slice(0, index + 1)];
      const match = candidates.find(item => item.option.label.toLowerCase().startsWith(text));
      if (match) { event.preventDefault(); focus(match.option.value); }
    }
  };
  useEffect(() => {
    const element = container.current;
    if (element && focused && document.activeElement === element)
      document.getElementById(optionId(focused.option.value))?.scrollIntoView({ block: "nearest" });
  }, [key, focused?.option.value]);
  return <div className={`list-tree-input ${tree ? "is-tree" : "is-list"}`}>
    <span className="list-tree-label" id={`${statusId}-label`}>{props.label}</span>
    <div className="list-tree-options" ref={container} role={tree ? "tree" : "listbox"} aria-labelledby={`${statusId}-label`}
      aria-describedby={statusId} aria-disabled={disabled} aria-invalid={Boolean(props.error) || !selected}
      aria-activedescendant={!disabled && focused ? optionId(focused.option.value) : undefined}
      tabIndex={disabled ? -1 : props.tabIndex} onKeyDown={keyboard}>
      {visible.map(item => <div key={item.option.value} id={optionId(item.option.value)} role={tree ? "treeitem" : "option"}
        aria-selected={item.option.value === props.value} aria-expanded={tree && item.hasChildren ? expanded.has(item.option.value) : undefined}
        aria-level={tree ? item.depth : undefined} aria-posinset={tree ? item.position : undefined} aria-setsize={tree ? item.siblings : undefined}
        className={`list-tree-option${item.option.value === focused?.option.value ? " is-focused" : ""}${item.option.value === props.value ? " is-selected" : ""}`}
        style={tree ? { paddingLeft: `${(item.depth - 1) * 18 + 6}px` } : undefined}
        onClick={() => { if (!disabled) { container.current?.focus(); choose(item.option); } }}>
        {tree && (item.hasChildren ? <button type="button" className="tree-expander" tabIndex={-1} disabled={disabled}
          aria-label={`${expanded.has(item.option.value) ? "Collapse" : "Expand"} ${item.option.label}`} onMouseDown={event => event.preventDefault()}
          onClick={event => { event.stopPropagation(); if (!disabled) { container.current?.focus(); focus(item.option.value); toggle(item.option.value); } }}>
          <span aria-hidden="true">{expanded.has(item.option.value) ? "▾" : "▸"}</span>
        </button> : <span className="tree-expander-space" aria-hidden="true" />)}
        <span className="list-tree-option-label">{item.option.label}</span>
      </div>)}
      {!visible.length && <span className="list-tree-empty">{status}</span>}
    </div>
    <div className="list-tree-footer"><small id={statusId} role={props.error ? "alert" : "status"} className={props.error ? "error-text" : "muted"}>{status}</small>
      {props.onReload && <button type="button" className="button query-selection-reload" tabIndex={props.tabIndex} disabled={disabled || !selected} onClick={() => { if (!disabled && selected) void props.onReload?.(); }}>Reload selected record</button>}
    </div>
  </div>;
}
