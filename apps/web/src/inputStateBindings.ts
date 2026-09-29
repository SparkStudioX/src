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

/** One form owns only invalid transient drafts. Accepted values belong to state. */
export class InputStateBindingForm {
  private options: FormInputOptions | undefined;
  private key = "";
  private generation = 0;
  private active = true;
  private drafts = new Map<string, Draft>();
  constructor(private readonly changed: () => void = () => {}) {}
  activate() { this.active = true; }
  deactivate() { this.active = false; this.generation++; }
  update(options: FormInputOptions) {
    const key = JSON.stringify([options.document?.id, options.state?.key, options.contextKey, options.parameters,
      options.document?.components.map(item => [item.id, item.type, item.props.fieldKey, item.props.stateBinding,
        item.props.min, item.props.max, item.props.step, item.props.options, item.props.optionsSource, item.props.tagPath])]);
    if (key !== this.key) { this.key = key; this.generation++; this.drafts.clear(); }
    else if (options.active !== this.options?.active) this.generation++;
    this.options = options;
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
  assignment(automatic = false): (field: string, value: InputValue) => void {
    const generation = this.generation;
    return (field, value) => {
      const options = this.options;
      if (!this.active || generation !== this.generation || !options || !automatic && !options.active || !options.document || options.state?.isCurrent?.() === false) return;
      const component = options.document.components.find(item => isInput(item.type) && (item.props.fieldKey || item.id) === field);
      if (!component) return;
      const binding = component.props.stateBinding;
      if (binding === undefined) {
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
  }
}

/** Used by root screens, popups and every nested template form. */
export function useFormInputs(options: FormInputOptions): { inputs: InputValues; assign: (field: string, value: InputValue) => void; assignAutomatic: (field: string, value: InputValue) => void } {
  const [, refresh] = useState(0);
  const ref = useRef<InputStateBindingForm | null>(null);
  if (!ref.current) ref.current = new InputStateBindingForm(() => refresh(value => value + 1));
  const form = ref.current;
  form.update(options);
  useEffect(() => { form.activate(); refresh(value => value + 1); return () => form.deactivate(); }, [form]);
  return { inputs: form.values(), assign: form.assignment(), assignAutomatic: form.assignment(true) };
}
