import { QueryPropertyBindingEditor } from "./QueryPropertyBindingEditor";
import type { BindingContext } from "./propertyBindings";
import type { CanvasComponent, NamedQuery, QueryDatasetSource } from "./types";

export function DatasetBindingEditor(props: {
  component: CanvasComponent; context: BindingContext; queries: NamedQuery[]; allowUnresolvedScreenState?: boolean;
  onApply: (source: QueryDatasetSource) => void; onRemove?: () => void; onCancel: () => void;
}) {
  return <QueryPropertyBindingEditor {...props} datasetMode target="text" onApply={binding => props.onApply({
    queryId: binding.queryId, ...(binding.parameters ? { parameters: binding.parameters } : {}), ...(binding.refresh ? { refresh: binding.refresh } : {}),
  })} />;
}
