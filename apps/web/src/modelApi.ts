import { api } from "./api";
import type { ModelDefinition, ModelInstance } from "./modelWorkspace";
import type { ModelParameterRequirement } from "./types";

export interface ModelPage<T> { generation: number | string; items: T[]; offset: number; limit: number; total: number }
export interface ModelMetadata { unit?: string; description?: string; semanticType?: string; range?: { low: number; high: number }; attributes?: Record<string, string | number | boolean> }
export interface ModelReadInstance extends ModelInstance { metadata?: ModelMetadata; restrictedMembers: number }
export interface ModelTreeItem extends ModelMetadata {
  path: string; name: string; kind: "hierarchy" | "folder" | "instance" | "member";
  level?: string; definitionId?: string; version?: number; dataType?: string; quality?: string; value?: unknown;
}
export interface ModelLeaf { path: string; modelPath: string; dataType: string; kind: string; value: unknown; quality: string; timestamp?: string | null; sourceTimestamp?: string | null; receiptTimestamp?: string | null; metadata: ModelMetadata }
export interface ModelMembers { [key: string]: ModelLeaf | ModelMembers }
export interface ModelObject extends ModelReadInstance { generation: number | string; members: ModelMembers }
export const modelChangedEvent = "sparkstudio:model-changed";

/** Every page must describe the same configuration, never a mixture across an Apply. */
async function allPages<T>(path: string, signal?: AbortSignal): Promise<T[]> {
  const items: T[] = []; let generation: number | string | undefined;
  for (let offset = 0; offset < 10000;) {
    const page = await api<ModelPage<T>>(`${path}${path.includes("?") ? "&" : "?"}offset=${offset}&limit=200`, "GET", undefined, signal);
    if (generation !== undefined && generation !== page.generation) throw new Error("The model changed while loading. Refresh to read the current configuration.");
    generation = page.generation; items.push(...page.items); offset += page.items.length;
    if (offset >= page.total || !page.items.length) return items;
  }
  throw new Error("Too many model items. Narrow the selection and refresh.");
}
export const getModelTypes = (signal?: AbortSignal) => allPages<ModelDefinition>("/model/types", signal);
export const getModelInstances = (requirement?: ModelParameterRequirement, signal?: AbortSignal) => allPages<ModelReadInstance>(`/model/instances${requirement ? `?type=${encodeURIComponent(requirement.definitionId)}` : ""}`, signal)
  .then(items => items.filter(item => !requirement || matchesModelRequirement(item, requirement)));
export const getModelObject = (path: string, signal?: AbortSignal) => api<ModelObject>(`/model/object?path=${encodeURIComponent(path)}`, "GET", undefined, signal);
export const getModelTree = (path = "[default]", offset = 0, signal?: AbortSignal) => api<ModelPage<ModelTreeItem>>(`/model/tree?path=${encodeURIComponent(path)}&depth=1&offset=${offset}&limit=100`, "GET", undefined, signal);
export function matchesModelRequirement(instance: Pick<ModelInstance, "definitionId" | "version">, requirement: ModelParameterRequirement): boolean {
  return instance.definitionId === requirement.definitionId && (requirement.minVersion === undefined || instance.version >= requirement.minVersion)
    && (requirement.maxVersion === undefined || instance.version <= requirement.maxVersion);
}
export function modelLeaves(members: ModelMembers): ModelLeaf[] {
  return Object.values(members).flatMap(value => typeof value.path === "string" && typeof value.modelPath === "string" && typeof value.dataType === "string"
    ? [value as unknown as ModelLeaf] : modelLeaves(value as ModelMembers));
}
