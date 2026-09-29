export interface ListTreeOption { value: string; label: string; parentValue?: string }
export interface VisibleTreeOption { option: ListTreeOption; depth: number; hasChildren: boolean; position: number; siblings: number }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= maximum;

/** Validate the entire flat graph before rendering or applying an authored edit. */
export function validateListTreeOptions(type: "list" | "treeView", value: unknown, maximum: 100 | 500 = 100): ListTreeOption[] {
  if (!Array.isArray(value) || value.length < (maximum === 500 ? 0 : 1) || value.length > maximum)
    throw new Error(`Configure ${maximum === 500 ? "at most " : "1–"}${maximum} ${type === "treeView" ? "tree nodes" : "list options"}.`);
  const nodes = value.map((item): ListTreeOption => {
    if (!object(item) || Object.keys(item).some(key => !["value", "label", ...(type === "treeView" ? ["parentValue"] : [])].includes(key)) ||
      !Object.hasOwn(item, "value") || !Object.hasOwn(item, "label") || !text(item.value, 4096) || !text(item.label, 200))
      throw new Error("Options need only a nonempty text value up to 4096 characters and label up to 200 characters; only tree nodes accept parentValue.");
    if (Object.hasOwn(item, "parentValue") && (typeof item.parentValue !== "string" || item.parentValue !== "" && !text(item.parentValue, 4096)))
      throw new Error("A tree parent must be an existing node value, or empty for a root node.");
    const parent = Object.hasOwn(item, "parentValue") ? item.parentValue as string : undefined;
    return { value: item.value, label: item.label, ...(parent ? { parentValue: parent } : {}) };
  });
  const byValue = new Map(nodes.map(node => [node.value, node]));
  if (byValue.size !== nodes.length) throw new Error("Each option needs a unique value.");
  if (type === "list") return nodes;
  for (const node of nodes) {
    if (node.parentValue === node.value) throw new Error(`Tree node '${node.label}' cannot be its own parent.`);
    if (node.parentValue !== undefined && !byValue.has(node.parentValue)) throw new Error(`Tree node '${node.label}' references a missing parent.`);
  }
  const depths = new Map<string, number>();
  const depth = (node: ListTreeOption, path: Set<string>): number => {
    if (path.has(node.value)) throw new Error("Tree parents cannot contain a cycle.");
    if (depths.has(node.value)) return depths.get(node.value)!;
    if (path.size >= 16) throw new Error("A tree can have at most 16 levels, counting its root as level 1.");
    path.add(node.value);
    const result = node.parentValue === undefined ? 1 : depth(byValue.get(node.parentValue)!, path) + 1;
    path.delete(node.value);
    if (result > 16) throw new Error("A tree can have at most 16 levels, counting its root as level 1.");
    depths.set(node.value, result); return result;
  };
  nodes.forEach(node => depth(node, new Set()));
  return nodes;
}

/** Saved sibling order is stable even when the incoming array lists children first. */
export function visibleTreeOptions(options: readonly ListTreeOption[], expanded: ReadonlySet<string>): VisibleTreeOption[] {
  const children = new Map<string | undefined, ListTreeOption[]>();
  for (const option of options) { const siblings = children.get(option.parentValue) ?? []; siblings.push(option); children.set(option.parentValue, siblings); }
  const result: VisibleTreeOption[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    const siblings = children.get(parent) ?? [];
    siblings.forEach((option, index) => {
      const hasChildren = children.has(option.value);
      result.push({ option, depth, hasChildren, position: index + 1, siblings: siblings.length });
      if (hasChildren && expanded.has(option.value)) walk(option.value, depth + 1);
    });
  };
  walk(undefined, 1); return result;
}

export function treeAncestors(options: readonly ListTreeOption[], value: string | null): Set<string> {
  const byValue = new Map(options.map(option => [option.value, option])), result = new Set<string>();
  let node = value === null ? undefined : byValue.get(value);
  while (node?.parentValue && !result.has(node.parentValue)) { result.add(node.parentValue); node = byValue.get(node.parentValue); }
  return result;
}
