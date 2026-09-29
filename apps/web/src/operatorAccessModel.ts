export type RuntimePresentation = "application" | "controls";

/** A bare operator link presents only the application; controls are an explicit opt-in. */
export function runtimePresentation(search: string): RuntimePresentation {
  const values = new URLSearchParams(search).getAll("view");
  return values.length === 1 && values[0] === "controls" ? "controls" : "application";
}

/** Operator links identify a project, never a user, session or publication. */
export function operatorProjectLink(projectId: string, publicBaseUrl: string, origin: string, presentation: RuntimePresentation = "application"): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(projectId)) throw new Error("Invalid project ID.");
  const base = new URL(publicBaseUrl || origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new Error("The operator base URL must be an HTTP or HTTPS address without credentials, query parameters or a fragment.");
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/runtime/${encodeURIComponent(projectId)}`;
  if (presentation === "controls") base.searchParams.set("view", "controls");
  return base.href;
}
