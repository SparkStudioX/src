const destinations: Record<string, { label: string; url: string; nextStep?: string }> = {
  projects: { label: "Projects", url: "/" },
  overview: { label: "Gateway overview", url: "/gateway#overview" },
  data: { label: "Gateway data", url: "/gateway#data" },
  connections: { label: "Gateway connections", url: "/gateway#data/connections" },
  tags: { label: "Tags", url: "/workspace?workspace=tags" },
  models: { label: "Models", url: "/workspace?workspace=models&view=plant" },
  "model-settings": { label: "Models data update settings", url: "/workspace?workspace=models&view=settings" },
  certificates: { label: "Public OPC certificates", url: "/gateway#data/certificates" },
  ai: { label: "AI settings", url: "/gateway#ai" },
  alarms: { label: "Gateway alarms", url: "/gateway#alarms" },
  history: { label: "Gateway history", url: "/gateway#history" },
  deployment: { label: "Gateway deployment", url: "/gateway#deployment" },
  backups: { label: "Gateway backups and recovery", url: "/gateway#backups" },
  sessions: { label: "Gateway sessions", url: "/gateway#sessions" },
  diagnostics: { label: "Gateway diagnostics", url: "/gateway#diagnostics" },
  security: { label: "Gateway security", url: "/gateway#security" },
  audit: { label: "Gateway audit", url: "/gateway#audit" },
};
const projectDestinations: Record<string, string> = { designer: "Designer", queries: "Queries", scripts: "Scripts" };
const modelTools = ["live", "issues", "versions", "mappings", "dependencies", "publish", "export", "start"];
const models = (params: Record<string, string>) => "/workspace?" + new URLSearchParams({ workspace: "models", ...params }).toString();
const providerPrefix = /^\[[A-Za-z0-9_-]{1,64}\]/;
const validPath = (value: unknown): value is string => typeof value === "string" && value.length <= 1100 && providerPrefix.test(value) && [...value].every(character => character.charCodeAt(0) >= 32);

/** Exact Models pages: a model version, a machine, a location or one Check & share tool. */
function modelDestination(destination: string, args: Record<string, unknown>): { label: string; url: string } | undefined {
  if (destination === "model") {
    if (typeof args.modelKey !== "string" || !/^[A-Za-z0-9_.-]{1,64}@[1-9][0-9]{0,8}$/.test(args.modelKey)) throw new Error("Give modelKey as ModelId@version.");
    return { label: "Model " + args.modelKey, url: models({ view: "models", type: args.modelKey }) };
  }
  if (destination === "machine" || destination === "location") {
    if (!validPath(args.path)) throw new Error("Give the full " + destination + " path, such as [default]Site/Line1.");
    return { label: (destination === "machine" ? "Machine " : "Location ") + args.path, url: models({ view: "plant", item: args.path, kind: destination }) };
  }
  if (destination === "model-tools") {
    const tool = typeof args.tool === "string" ? args.tool : "live";
    if (!modelTools.includes(tool)) throw new Error("Choose a supported Models tool.");
    return { label: "Models check and share tools", url: models({ view: "tools", tool }) };
  }
  return undefined;
}

/** Return a fixed local link without reloading an active conversation or discarding browser drafts. */
export function askSparkNavigationLink(args: Record<string, unknown>, context: { projectId?: string | null }) {
  const destination = String(args.destination);
  let target: { label: string; url: string; nextStep?: string } | undefined = Object.hasOwn(destinations, destination) ? destinations[destination] : modelDestination(destination, args);
  if (Object.hasOwn(projectDestinations, destination)) {
    const projectId = args.projectId ?? context.projectId;
    if (typeof projectId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(projectId)) throw new Error("Choose an explicit project before requesting its workspace link.");
    target = { label: projectDestinations[destination], url: `/designer/${encodeURIComponent(projectId)}`, nextStep: destination === "designer" ? undefined : `Select ${projectDestinations[destination]} in the workspace navigation.` };
  }
  if (!target) throw new Error("Choose a supported engineering workspace.");
  return { status: "awaiting_user_navigation", navigated: false, ...target, markdown: `[Open ${target.label}](${target.url})`, guidance: "Show this link to the user. Navigation happens only when they follow it; their current conversation and unsaved drafts remain in this tab. Destination permissions still apply." };
}
