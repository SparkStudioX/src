import type { CanvasComponent, QueryPropertyValues } from "./types";

/** Query/style failures share the same status display for leaves and template wrappers. */
export function componentBindingDiagnostics(component: CanvasComponent, bindingErrors: Record<string, string>, styleError: string | undefined, queryProperties: QueryPropertyValues | undefined) {
  const errors = Object.entries(bindingErrors);
  if (styleError) errors.push(["style", styleError]);
  const querySamples = queryProperties?.[component.id] ?? {};
  const queryWaiting = errors.length > 0 && errors.every(([target]) => querySamples[target as keyof typeof querySamples]?.status === "loading");
  const queryErrors = errors.filter(([target]) => Object.hasOwn(component.props.queryBindings ?? {}, target));
  const queryRefreshing = Object.values(querySamples).some(sample => sample?.status === "ready" && sample.refreshing);
  return { errors, queryWaiting, queryErrors, queryRefreshing };
}

export function renderBindingDiagnostics({ errors, queryWaiting, queryErrors, queryRefreshing }: ReturnType<typeof componentBindingDiagnostics>) {
  return <>
    {errors.length > 0 && <div className="component-binding-error" role="status" title={errors.map(([target, error]) => `${target}: ${error}`).join("\n")}>
      {queryWaiting ? "Loading query…" : queryErrors.length ? `Query unavailable: ${queryErrors.map(([target]) => target).join(", ")}` : `Binding error: ${errors.map(([target]) => target).join(", ")}`}
    </div>}
    {!errors.length && queryRefreshing && <div className="query-property-refreshing" role="status">Refreshing query…</div>}
  </>;
}
