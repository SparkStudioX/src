import type { Asset, Project } from "./types";

export interface AssetUse {
  id: string;
  ownerKind: "screen" | "template";
  ownerId: string;
  componentId: string;
  location: string;
  assetId: string;
  alt: string;
}
export interface AssetReplacementPlan {
  sourceId: string;
  replacementId: string;
  signature: string;
  uses: AssetUse[];
  errors: string[];
}
const validId = (value: string) => /^[a-f0-9]{64}$/.test(value);

/** Structured image uses only. A shared definition is listed once, not per placement. */
export function projectAssetUses(project: Project): AssetUse[] {
  const uses: AssetUse[] = [];
  for (const [ownerKind, documents] of [["screen", project.screens], ["template", project.templates ?? []]] as const)
    for (const document of documents)
      for (const component of document.components)
        if (component.type === "image" && typeof component.props.assetId === "string" && component.props.assetId)
          uses.push({ id: JSON.stringify([ownerKind, document.id, component.id]), ownerKind, ownerId: document.id, componentId: component.id,
            location: `${ownerKind === "screen" ? "Screen" : "Template"} · ${document.name} / ${component.props.text || component.id}`, assetId: component.props.assetId, alt: component.props.alt ?? "" });
  return uses;
}

function signature(project: Project, assets: readonly Asset[], sourceId: string, replacementId: string): string {
  return JSON.stringify([project, [...assets].sort((a, b) => a.id.localeCompare(b.id)), sourceId, replacementId]);
}

export function planAssetReplacement(project: Project, assets: readonly Asset[], sourceId: string, replacementId: string): AssetReplacementPlan {
  const errors: string[] = [];
  if (!validId(sourceId)) errors.push("Choose a valid source image.");
  if (!validId(replacementId) || !assets.some(asset => asset.id === replacementId)) errors.push("Choose a replacement image available in this project's local library.");
  if (sourceId === replacementId) errors.push("Choose a different replacement image.");
  const uses = projectAssetUses(project).filter(use => use.assetId === sourceId);
  if (!uses.length) errors.push("This image has no structured uses in the current project draft.");
  return { sourceId, replacementId, signature: signature(project, assets, sourceId, replacementId), uses, errors };
}

/** Change only selected image asset IDs; retained bytes continue serving publications. */
export function applyAssetReplacement(plan: AssetReplacementPlan, project: Project, assets: readonly Asset[], selectedUseIds: readonly string[]): Project {
  if (signature(project, assets, plan.sourceId, plan.replacementId) !== plan.signature) throw new Error("The project or asset library changed. Refresh the replacement preview.");
  const fresh = planAssetReplacement(project, assets, plan.sourceId, plan.replacementId);
  if (fresh.errors.length) throw new Error(fresh.errors.join(" "));
  const selected = new Set(selectedUseIds);
  if (!selected.size || selected.size !== selectedUseIds.length || [...selected].some(id => !fresh.uses.some(use => use.id === id)))
    throw new Error("Select valid image uses from the current replacement preview.");
  const next = structuredClone(project);
  for (const use of fresh.uses) {
    if (!selected.has(use.id)) continue;
    const documents = use.ownerKind === "screen" ? next.screens : next.templates ?? [];
    const component = documents.find(document => document.id === use.ownerId)!.components.find(item => item.id === use.componentId)!;
    component.props.assetId = fresh.replacementId;
  }
  return next;
}
