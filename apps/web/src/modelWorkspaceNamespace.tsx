import { useState } from "react";
import type { Tag } from "./types";
import { modelLevels, type ModelPackage, type ModelExpandedTag, type ModelHierarchy } from "./modelWorkspace";

interface NamespaceNode { path: string; name: string; kind: "folder" | "hierarchy" | "instance" | "member"; level?: string; type?: string; version?: number; instance?: string; tag?: ModelExpandedTag; live?: Tag; depth: number; outside?: boolean }
const parentPath = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : path === "[default]" ? "" : "[default]";
export const modelLocationName = (path: string) => path.replace(/^\[default\]/, "").split("/").at(-1) || "";
const withinLocation = (path: string, root: string) => path === root || path.startsWith(root + "/");
const locationPrefix = (parent: string) => parent === "[default]" ? parent : parent + "/";
export function nextModelLocationLevel(model: ModelPackage, parent: string): string {
  for (let path = parent; path; path = parentPath(path)) {
    const level = model.hierarchy.find(item => item.path === path)?.level;
    if (level && level !== "Custom") return modelLevels[modelLevels.indexOf(level) + 1] || "Custom";
  }
  return "Enterprise";
}
export function renameModelLocation(model: ModelPackage, path: string, name: string): ModelPackage {
  if (model.hierarchy.filter(item => item.path === path).length !== 1) throw new Error("Select one unique location to rename.");
  name = name.trim();
  if (!name || name === "." || name === ".." || /[/\\[\]{}]/.test(name) || [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159)) throw new Error("Enter a location name without slashes, brackets, braces or control characters.");
  const destination = locationPrefix(parentPath(path)) + name;
  if (destination === path) return model;
  const occupied = [...model.hierarchy, ...model.instances, ...model.tags as { path: string }[]];
  if (occupied.some(item => !withinLocation(item.path, path) && withinLocation(item.path, destination))) throw new Error(`A location or value already exists at ${destination}. Choose another name.`);
  const renamed = <T extends { path: string }>(item: T): T => {
    if (!withinLocation(item.path, path)) return item;
    const nextPath = destination + item.path.slice(path.length);
    if (nextPath.length > 512) throw new Error("Renaming would create a path longer than 512 characters.");
    return { ...item, path: nextPath };
  };
  return { ...model, hierarchy: model.hierarchy.map(renamed), instances: model.instances.map(renamed) };
}
function hasAncestor(path: string, paths: Set<string>, self = false): boolean { for (let value = self ? path : parentPath(path); value; value = parentPath(value)) if (paths.has(value)) return true; return false; }
export function visibleModelNamespace(nodes: NamespaceNode[], expanded: Set<string>): NamespaceNode[] { return nodes.filter(node => { for (let value = parentPath(node.path); value; value = parentPath(value)) if (!expanded.has(value)) return false; return true; }); }
export function modelNamespace(model: ModelPackage, definitions: ModelExpandedTag[], tags: Tag[]): NamespaceNode[] {
  const nodes = new Map<string, NamespaceNode>(), live = new Map(tags.map(tag => [tag.path, tag]));
  const hierarchy = new Set(model.hierarchy.map(node => node.path)), outside = (path: string) => !hasAncestor(path, hierarchy);
  function add(path: string, patch: Partial<NamespaceNode>) {
    if (!path) return;
    const parent = parentPath(path); if (parent && !nodes.has(parent)) add(parent, {});
    nodes.set(path, { path, name: path.replace(/^\[default\]/, "").split("/").at(-1) || "[default]", kind: "folder", depth: path === "[default]" ? 1 : path.split("/").length + 1, ...nodes.get(path), ...patch });
  }
  for (const node of model.hierarchy) add(node.path, { kind: "hierarchy", level: node.level });
  for (const instance of model.instances) add(instance.path, { kind: "instance", type: instance.definitionId, version: instance.version, instance: instance.path, outside: outside(instance.path) });
  for (const tag of definitions) add(tag.path, { kind: "member", tag, live: live.get(tag.path), type: tag.udtDefinition, instance: tag.udtInstance, outside: tag.udtInstance ? outside(tag.udtInstance) : false });
  return [...nodes.values()].sort((a, b) => a.path.localeCompare(b.path));
}
export function filterModelNamespace(nodes: NamespaceNode[], filter: { text: string; type: string; level: string; quality: string; outside: boolean }): NamespaceNode[] {
  const levels = new Set(nodes.filter(node => node.level === filter.level).map(node => node.path));
  const matching = nodes.filter(node => (!filter.text || node.path.toLowerCase().includes(filter.text.toLowerCase())) && (!filter.type || node.type === filter.type) && (!filter.level || hasAncestor(node.path, levels, true)) && (!filter.quality || (filter.quality === "Good" ? node.live?.quality === "Good" : Boolean(node.live && node.live.quality !== "Good"))) && (!filter.outside || node.outside));
  const paths = new Set<string>(); for (const node of matching) { let path = node.path; while (path) { paths.add(path); path = parentPath(path); } }
  return nodes.filter(node => paths.has(node.path));
}
export function moveModelInstances(model: ModelPackage, paths: string[], parent: string): ModelPackage {
  if (!model.hierarchy.some(node => node.path === parent)) throw new Error("Choose a location as the destination.");
  if (!paths.length) throw new Error("Select equipment to move.");
  if (paths.some(path => !model.instances.some(instance => instance.path === path))) throw new Error("A selected instance is no longer in this draft.");
  const selected = new Set(paths), occupied = new Set(model.instances.filter(item => !selected.has(item.path)).map(item => item.path));
  const instances = model.instances.map(instance => {
    if (!selected.has(instance.path)) return instance;
    const path = parent + "/" + instance.path.replace(/^\[default\]/, "").split("/").at(-1);
    if (occupied.has(path)) throw new Error(`An instance already exists at ${path}.`);
    occupied.add(path); return { ...instance, path };
  });
  return { ...model, instances };
}
export function LocationFields({ node, onRename, onPatch }: { node: ModelHierarchy; onRename: (name: string) => void; onPatch: (value: Partial<ModelHierarchy>) => void }) {
  const [name, setName] = useState(() => modelLocationName(node.path)), [error, setError] = useState("");
  const rename = () => { try { onRename(name); setName(name.trim()); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  const changed = name !== modelLocationName(node.path);
  return <><div className="model-grid"><label>Location name<input aria-label="Location name" value={name} onChange={event => { setName(event.target.value); setError(""); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); rename(); } else if (event.key === "Escape") { event.preventDefault(); setName(modelLocationName(node.path)); setError(""); } }} /></label><label>Location kind<select aria-label="Location kind" value={node.level} onChange={event => onPatch({ level: event.target.value })}>{modelLevels.map(level => <option key={level}>{level}</option>)}</select></label></div>
    {changed && <div className="model-actions"><button type="button" className="button small" onClick={rename}>Rename location</button><button type="button" className="button small" onClick={() => { setName(modelLocationName(node.path)); setError(""); }}>Cancel rename</button></div>}
    {error && <p className="security-error" role="alert">{error}</p>}<p className="model-field-help">Rename changes this location and the paths of its locations and equipment together. Source tags stay in place. Review affected screen bindings before applying.</p></>;
}
/** Adds the next ISA-95 level under a parent and returns the new path for naming. */
export function addModelLocation(model: ModelPackage, parent: string): { model: ModelPackage; path: string; level: string } {
  const level = nextModelLocationLevel(model, parent), base = locationPrefix(parent) + (level === "Custom" ? "Location" : level);
  const occupied = [...model.hierarchy, ...model.instances, ...model.tags as { path: string }[]];
  let path = base, suffix = 2; while (occupied.some(item => item.path === path)) path = base + suffix++;
  return { model: { ...model, hierarchy: [...model.hierarchy, { path, level }] }, path, level };
}
