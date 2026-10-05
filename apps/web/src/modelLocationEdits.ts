import type { ModelPackage } from "./modelWorkspace";

/** Pure location and machine path edits shared by the Models page and Ask Spark drafts. */
export const parentPath = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : path === "[default]" ? "" : "[default]";
const withinLocation = (path: string, root: string) => path === root || path.startsWith(root + "/");
export const locationPrefix = (parent: string) => parent === "[default]" ? parent : parent + "/";
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
