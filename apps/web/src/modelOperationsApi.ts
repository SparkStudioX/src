import { api } from "./api";
import type { ModelDefinition, ModelPackage } from "./modelWorkspace";

export interface ModelIssue { path: string; instancePath: string; modelPath: string; code: string; message: string; expected: string; quality: string; sourceQuality: string; value: unknown; receiptTimestamp?: string; target?: string }
export interface ModelIssuePage { generation: string | number; items: ModelIssue[]; total: number; offset: number; limit: number; nextOffset?: number | null }
export interface ModelVersionImpact { definitionId: string; fromVersion: number | null; toVersion: number; classification: "initial" | "compatible" | "breaking" | "unchanged"; changes: { path: string; kind: string; reason: string }[]; usage: { path: string; version: number }[]; affectedProjects: { id: string; name: string }[]; requiresReview: true }
export interface ModelDependencyGraph { nodes: { id: string; kind: string; label: string; path?: string }[]; edges: { from: string; to: string; relation: string }[]; issues: { kind: string; id: string; message: string }[]; truncated: boolean }
export interface ModelExportResult { package: ModelPackage; externalDependencies: { kind: string; id: string; reason: string }[]; summary: { types: number; instances: number; tags: number; locations: number; mappings: number } }
export interface ModelStarter { id: string; name: string; description: string; definition: ModelDefinition; walkthrough: string[] }
export const getModelIssues = (path: string, offset = 0, signal?: AbortSignal) => api<ModelIssuePage>(`/model/issues?path=${encodeURIComponent(path)}&offset=${offset}&limit=100`, "GET", undefined, signal);
export const compareModelVersion = (definition: ModelDefinition, fromVersion?: number, definitions?: ModelDefinition[]) => api<ModelVersionImpact>("/model/versions/compare", "POST", { definition, fromVersion, definitions });
export const getModelDependencies = (type: string, instance: string, query: string) => api<ModelDependencyGraph>(`/model/dependencies?type=${encodeURIComponent(type)}&instance=${encodeURIComponent(instance)}&query=${encodeURIComponent(query)}`);
export const exportModelSelection = (definitionKeys: string[], instancePaths: string[], includeSourceTags: boolean) => api<ModelExportResult>("/model/export", "POST", { definitionKeys, instancePaths, includeSourceTags });
export const getModelStarters = () => api<{ items: ModelStarter[] }>("/model/starters");
export const modelErrorText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
export function downloadModelBundle(result: ModelExportResult) {
  const value = { format: "sparkstudio.model-bundle", version: 1, package: result.package, externalDependencies: result.externalDependencies };
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  try { const link = document.createElement("a"); link.href = url; link.download = "sparkstudio-model-bundle.json"; link.click(); } finally { URL.revokeObjectURL(url); }
}
