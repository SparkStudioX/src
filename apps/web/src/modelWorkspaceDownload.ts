import { ApiError, apiUrl, authenticatedFetch, assertAuthResponseCurrent } from "./api";
import { preparePreviewRequest } from "./previewRequest";

const maximumBytes = 32 * 1024 * 1024;
type TransferResponse = { format?: string; version?: number; message?: string; error?: string; detail?: string } | null;

/** Preserve the reviewed package text exactly rather than reserializing parsed values. */
async function modelTransferRequest(path: string, body?: string) {
  if (body !== undefined && new Blob([body]).size > maximumBytes) throw new Error("The tag import request exceeds 32 MiB. Split the package into smaller imports.");
  const preview = preparePreviewRequest(path);
  try {
    const response = await authenticatedFetch(apiUrl(preview.path), {
      signal: preview.signal, method: body === undefined ? "GET" : "POST", body,
      headers: { ...preview.headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    });
    const raw = await response.text();
    preview.assertCurrent();
    if (response.status !== 401) assertAuthResponseCurrent(response);
    let data: TransferResponse;
    try { data = JSON.parse(raw); } catch { data = null; }
    if (!response.ok) throw new ApiError(data?.message || data?.error || data?.detail || `Model transfer failed (${response.status}).`, response.status);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The gateway returned an invalid model transfer response.");
    return { raw, data };
  } finally { preview.finish(); }
}

export async function readModelExport(): Promise<string> {
  const { raw, data } = await modelTransferRequest("/tag-engineering/export");
  if (data.format !== "sparkstudio.tags" || data.version !== 3) throw new Error("The gateway returned an invalid current model export.");
  return raw;
}

function validatePackageText(raw: string): void {
  if (new Blob([raw]).size > maximumBytes) throw new Error("Tag packages are limited to 32 MiB.");
  const package_ = JSON.parse(raw);
  if (!package_ || typeof package_ !== "object" || Array.isArray(package_)) throw new Error("A tag package must be a JSON object.");
  if (package_.format !== "sparkstudio.tags" || package_.version !== 3) throw new Error("This tag package uses an unsupported format. Import a package exported by the current gateway; older tag formats are not supported.");
}

export async function previewModelImport<T>(packageText: string): Promise<T> {
  validatePackageText(packageText);
  return (await modelTransferRequest("/tag-engineering/preview", packageText)).data as T;
}

export async function applyModelImport(packageText: string, revision: string, previewToken: string): Promise<void> {
  validatePackageText(packageText);
  if (!revision || !previewToken) throw new Error("Preview this tag package before applying it.");
  // Only the envelope is serialized: the exact reviewed package is embedded unchanged.
  const body = `{"package":${packageText},"revision":${JSON.stringify(revision)},"previewToken":${JSON.stringify(previewToken)}}`;
  await modelTransferRequest("/tag-engineering/apply", body);
}

export async function downloadModelExport(): Promise<void> {
  const raw = await readModelExport();
  const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
  try { const link = document.createElement("a"); link.href = url; link.download = "sparkstudio-tags.json"; link.click(); }
  finally { URL.revokeObjectURL(url); }
}
