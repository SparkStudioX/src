import { useEffect, useRef, useState } from "react";
import { resolveInputs, isInput, validateInputs, stateInputError } from "./inputs";
import type { StateContext } from "./applicationStateModel";
import type { CanvasComponent, InputValue, InputValues, RuntimeParameters, Screen, Tag } from "./types";

export interface FormInputOptions {
  document: Screen | undefined;
  tags: Tag[];
  parameters: RuntimeParameters;
  edits?: InputValues;
  communicationLost?: boolean;
  state?: StateContext;
  onEdit: (field: string, value: InputValue, automatic?: boolean) => void;
  active: boolean;
  /** Changes when an otherwise identical authoring/row form must expire. */
  contextKey?: string;
}
interface Draft { value: InputValue; stamp: string }
export interface PythonFormInputCapture {
  /** Validate every expected field revision before returning an all-input commit. */
  prepare: (values: Record<string, InputValue>) => () => void;
}
export type AutomaticInputAssignment = ((field: string, value: InputValue) => void) & { capturePythonInputs?: () => PythonFormInputCapture };

/** One form owns only invalid transient drafts. Accepted values belong to state. */
export class InputStateBindingForm {
  private options: FormInputOptions | undefined;
  private key = "";
  private generation = 0;
  private contextGeneration = 0;
  private active = true;
  private drafts = new Map<string, Draft>();
  private fieldRevisions = new Map<string, number>();
  private observed: InputValues = {};
  constructor(private readonly changed: () => void = () => {}) {}
  assignmentGeneration() { return this.generation; }
  activate() { this.active = true; }
  deactivate() { this.active = false; this.generation++; this.contextGeneration++; }
  update(options: FormInputOptions) {
    const key = JSON.stringify([options.document?.id, options.state?.key, options.contextKey, options.parameters,
      options.document?.components.map(item => [item.id, item.type, item.props.fieldKey, item.props.stateBinding,
        item.props.min, item.props.max, item.props.step, item.props.options, item.props.optionsSource, item.props.tagPath])]);
    if (key !== this.key) { this.key = key; this.generation++; this.contextGeneration++; this.drafts.clear(); this.fieldRevisions.clear(); this.observed = {}; }
    else if (options.active !== this.options?.active) this.generation++;
    this.options = options;
    this.observe();
  }
  private observe() {
    const next = this.values();
    for (const key of new Set([...Object.keys(next), ...Object.keys(this.observed)]))
      if (!Object.is(next[key], this.observed[key])) this.fieldRevisions.set(key, (this.fieldRevisions.get(key) ?? 0) + 1);
    this.observed = { ...next };
  }
  private capturePythonInputs(): PythonFormInputCapture {
    this.observe();
    const contextGeneration = this.contextGeneration, expected = new Map(this.fieldRevisions);
    const live = () => this.active && this.contextGeneration === contextGeneration && this.options?.state?.isCurrent?.() !== false;
    if (!live()) throw new Error("This input form has closed.");
    return { prepare: values => {
      if (!live()) throw new Error("This input form has closed. Its input changes were discarded.");
      this.observe();
      for (const [field, value] of Object.entries(values)) {
        if ((this.fieldRevisions.get(field) ?? 0) !== (expected.get(field) ?? 0)) throw new Error(`Input '${field}' changed while Python was running. Its UI changes were discarded.`);
        const options = this.options!, component = options.document?.components.find(item => isInput(item.type) && (item.props.fieldKey || item.id) === field);
        if (!component || component.type === "passwordInput" || component.props.stateBinding || component.props.tagPath || component.props.optionsSource || component.props.selectionFields || component.props.readOnly === true ||
          Object.hasOwn(component.props.bindings ?? {}, "value") || Object.hasOwn(component.props.queryBindings ?? {}, "value"))
          throw new Error("Python input assignments require an unbound non-password field in the calling form.");
        const error = validateInputs({ ...options.document!, components: [component] }, { [field]: value }, options.parameters);
        if (error) throw new Error(error);
      }
      return () => {
        if (!live()) throw new Error("This input form has closed. Its input changes were discarded.");
        const assign = this.assignment(true);
        for (const [field, value] of Object.entries(values)) assign(field, value);
      };
    } };
  }
  private stamp(component: CanvasComponent): string {
    const binding = component.props.stateBinding!;
    const state = this.options?.state;
    return JSON.stringify([state?.key, binding, state?.revision?.(binding.scope, binding.key), state?.api.get(binding.scope, binding.key)]);
  }
  values(): InputValues {
    const options = this.options;
    if (!options?.document) return {};
    const inputs = resolveInputs(options.document, options.tags, options.parameters, options.edits, options.communicationLost, options.state?.values);
    for (const component of options.document.components) {
      if (!component.props.stateBinding || stateInputError(component, options.state?.values)) continue;
      const field = component.props.fieldKey || component.id, draft = this.drafts.get(field);
      if (draft && draft.stamp === this.stamp(component)) inputs[field] = draft.value;
      else if (draft) this.drafts.delete(field);
    }
    return inputs;
  }
  assignment(automatic = false): AutomaticInputAssignment {
    const generation = this.generation;
    const assign: AutomaticInputAssignment = (field, value) => {
      const options = this.options;
      if (!this.active || generation !== this.generation || !options || !automatic && !options.active || !options.document || options.state?.isCurrent?.() === false) return;
      const component = options.document.components.find(item => isInput(item.type) && (item.props.fieldKey || item.id) === field);
      if (!component) return;
      this.fieldRevisions.set(field, (this.fieldRevisions.get(field) ?? 0) + 1);
      const binding = component.props.stateBinding;
      if (binding === undefined) {
        // Preserve immediate reads/revisions before the parent React update is committed.
        this.options = { ...options, edits: { ...options.edits, [field]: value } };
        if (automatic) options.onEdit(field, value, true);
        else options.onEdit(field, value);
        return;
      }
      if (!options.state || stateInputError(component, options.state.values)) return;
      // A dead scope can no longer write even before React unmounts its form.
      if (options.state.api.get(binding.scope, binding.key) === undefined) return;
      const error = validateInputs({ ...options.document, components: [component] }, { [field]: value }, options.parameters);
      if (error) this.drafts.set(field, { value, stamp: this.stamp(component) });
      else {
        options.state.api.set(binding.scope, binding.key, value);
        this.drafts.delete(field);
      }
      this.changed();
    };
    if (automatic) assign.capturePythonInputs = () => this.capturePythonInputs();
    return assign;
  }
}

/** Used by root screens, popups and every nested template form. */
export function useFormInputs(options: FormInputOptions): { inputs: InputValues; assign: (field: string, value: InputValue) => void; assignAutomatic: AutomaticInputAssignment } {
  const [, refresh] = useState(0);
  const ref = useRef<InputStateBindingForm | null>(null);
  if (!ref.current) ref.current = new InputStateBindingForm(() => refresh(value => value + 1));
  const form = ref.current;
  form.update(options);
  useEffect(() => { form.activate(); refresh(value => value + 1); return () => form.deactivate(); }, [form]);
  const stable = useRef<{ key: string; inputs: InputValues; assign: ReturnType<InputStateBindingForm["assignment"]>; assignAutomatic: ReturnType<InputStateBindingForm["assignment"]> } | null>(null);
  const values = form.values();
  const key = JSON.stringify([form.assignmentGeneration(), values, options.active, options.contextKey, options.state?.key, options.document, options.parameters]);
  if (!stable.current || stable.current.key !== key || options.state?.isCurrent() === false)
    stable.current = { key, inputs: values, assign: form.assignment(), assignAutomatic: form.assignment(true) };
  return stable.current;
}
