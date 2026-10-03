const destinations: Record<string, { label: string; url: string; nextStep?: string }> = {
  projects: { label: "Projects", url: "/" },
  overview: { label: "Gateway overview", url: "/gateway#overview" },
  configuration: { label: "Gateway configuration", url: "/gateway#configuration" },
  connections: { label: "Gateway connections", url: "/gateway#configuration", nextStep: "Select the Connections tab." },
  tags: { label: "Gateway tags", url: "/gateway#configuration", nextStep: "Select the Tags tab." },
  certificates: { label: "Public OPC certificates", url: "/gateway#configuration", nextStep: "Select the Public OPC certificates tab." },
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

/** Return a fixed local link without reloading an active conversation or discarding browser drafts. */
export function askSparkNavigationLink(args: Record<string, unknown>, context: { projectId?: string | null }) {
  const destination = String(args.destination);
  let target = Object.hasOwn(destinations, destination) ? destinations[destination] : undefined;
  if (Object.hasOwn(projectDestinations, destination)) {
    const projectId = args.projectId ?? context.projectId;
    if (typeof projectId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(projectId)) throw new Error("Choose an explicit project before requesting its workspace link.");
    target = { label: projectDestinations[destination], url: `/designer/${encodeURIComponent(projectId)}`, nextStep: destination === "designer" ? undefined : `Select ${projectDestinations[destination]} in the workspace navigation.` };
  }
  if (!target) throw new Error("Choose a supported engineering workspace.");
  return { status: "awaiting_user_navigation", navigated: false, ...target, markdown: `[Open ${target.label}](${target.url})`, guidance: "Show this link to the user. Navigation happens only when they follow it; their current conversation and unsaved drafts remain in this tab. Destination permissions still apply." };
}
