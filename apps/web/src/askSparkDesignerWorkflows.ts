import type { CanvasComponent, Project, Screen } from "./types";
import { documentFor, record, textArg } from "./askSparkDesignerModel";
import type { DesignerEdit, DesignerSnapshot, ToolArgs } from "./askSparkDesignerModel";

function addScreen(snapshot: DesignerSnapshot, args: ToolArgs, components: CanvasComponent[]): Project {
  const id = textArg(args, "newId");
  if ([...snapshot.project.screens, ...snapshot.project.templates ?? []].some(item => item.id === id)) throw new Error("Choose a new document ID.");
  const screen: Screen = { id, name: textArg(args, "name"), width: 1280, height: Math.max(720, ...components.map(item => item.y + item.height + 40)), components };
  return { ...snapshot.project, screens: [...snapshot.project.screens, screen] };
}
function tagScreen(snapshot: DesignerSnapshot, args: ToolArgs): Project {
  if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 100) throw new Error("Choose 1–100 existing tag paths.");
  const paths = args.paths.map(path => String(path));
  if (paths.some(path => !snapshot.tags.some(tag => tag.path === path))) throw new Error("Read available tags before generating a screen; a requested path does not exist.");
  const components: CanvasComponent[] = [{ id: "heading", type: "label", x: 32, y: 24, width: 1200, height: 48, props: { text: textArg(args, "name"), fontSize: 28 } }];
  paths.forEach((path, index) => {
    const x = 32 + index % 3 * 416, y = 100 + Math.floor(index / 3) * 130;
    components.push({ id: `name-${index}`, type: "label", x, y, width: 384, height: 36, props: { text: path, fontSize: 14 } },
      { id: `value-${index}`, type: "value", x, y: y + 40, width: 384, height: 60, props: { tagPath: path, fontSize: 30 } });
  });
  return addScreen(snapshot, args, components);
}
function queryScreen(snapshot: DesignerSnapshot, args: ToolArgs): Project {
  const queryId = textArg(args, "queryId"), query = snapshot.queries.find(item => item.id === queryId);
  if (!query || query.kind === "update") throw new Error("Choose an existing read query.");
  return addScreen(snapshot, args, [
    { id: "heading", type: "label", x: 32, y: 24, width: 1200, height: 48, props: { text: textArg(args, "name"), fontSize: 28 } },
    { id: "records", type: "table", x: 32, y: 96, width: 1216, height: 540, props: { queryId, pageSize: 25 } },
  ]);
}
function cloneEquipment(snapshot: DesignerSnapshot, args: ToolArgs): Project {
  const source = documentFor(snapshot, args), next = structuredClone(source), mapping = record(args.tagMap, "tagMap");
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replace);
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(object).map(([key, item]) => {
      const tagField = key === "tagPath" || key === "path" && object.kind === "tag";
      return [key, tagField && typeof item === "string" && typeof mapping[item] === "string" ? mapping[item] : replace(item)];
    }));
  };
  next.components = replace(next.components) as CanvasComponent[];
  const result = addScreen(snapshot, args, next.components);
  const added = result.screens[result.screens.length - 1];
  Object.assign(added, next, { id: textArg(args, "newId"), name: textArg(args, "name") });
  return result;
}
export const designerWorkflows: Record<string, DesignerEdit> = {
  spark_designer_generate_tag_screen: tagScreen, spark_designer_generate_query_screen: queryScreen,
  spark_designer_clone_equipment: cloneEquipment,
};
