import { ApiError, apiUrl, authenticatedFetch, assertAuthResponseCurrent } from "./api";
import type { ProjectPermissions } from "./authSession";

export interface ProjectSummary {
  id: string;
  name: string;
  revision: number;
  archived: boolean;
  isDefault?: boolean;
  createdAt: string;
  published: boolean;
  publishedAt?: string;
  publishedRevision?: number;
  permissions?: ProjectPermissions;
}
export interface ProjectCatalog { defaultProjectId: string | null; projects: ProjectSummary[] }
export const packageSizeLimit = 32 * 1024 * 1024;

async function requireSuccess(response: Response): Promise<void> {
  if (response.ok) return;
  const raw = await response.text();
  if (response.status !== 401) assertAuthResponseCurrent(response);
  let message = response.status === 403 ? "You do not have permission to manage this project." : response.status === 401 ? "Sign in to continue." : `Request failed (${response.status}).`;
  try { const data = JSON.parse(raw); message = data.message || data.error || data.detail || message; } catch { /* Keep transport error concise. */ }
  throw new ApiError(message, response.status);
}

export async function importProjectPackage(file: File, name = ""): Promise<ProjectSummary> {
  if (!file.size || file.size > packageSizeLimit) throw new Error("Choose a .sparkproj package between 1 byte and 32 MiB.");
  if (!/\.sparkproj$/i.test(file.name)) throw new Error("Choose a SparkStudio .sparkproj package.");
  const query = name.trim() ? `?name=${encodeURIComponent(name.trim())}` : "";
  const response = await authenticatedFetch(apiUrl(`/projects/import${query}`), { method: "POST", headers: { "Content-Type": "application/zip" }, body: file });
  await requireSuccess(response);
  const project = await response.json() as ProjectSummary;
  assertAuthResponseCurrent(response);
  return project;
}

export async function exportProjectPackage(project: Pick<ProjectSummary, "id" | "name">): Promise<void> {
  const response = await authenticatedFetch(apiUrl(`/projects/${encodeURIComponent(project.id)}/export`));
  await requireSuccess(response);
  const content = await response.blob();
  assertAuthResponseCurrent(response);
  const url = URL.createObjectURL(content);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${project.name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "project"}.sparkproj`;
  link.click();
  // Keep the URL alive until the browser has started its download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
