import { apiUrl, authenticatedFetch, assertAuthResponseCurrent, ApiError } from "./api";
import { authSessionRevision } from "./authSession";
import { abortable, blobDataUrl, canvasBlob } from "./askSparkVisual";
import type { AskSparkImage } from "./askSparkImages";
import type { Asset } from "./types";

export interface AskSparkCrop { sourceImageId: string; name: string; box: { x: number; y: number; width: number; height: number } }
export interface AskSparkCropUpload { name: string; contentType: "image/png"; dataBase64: string }
export interface AskSparkCropAsset { index: number; sourceImageId: string; requestedName: string; asset: Asset }
export interface AskSparkCropReceipt {
  status: "completed" | "partial" | "failed" | "cancelled"; requested: number; created: AskSparkCropAsset[];
  notAttempted: string[]; error?: string; failed?: { index: number; name: string; outcome: "rejected" | "unknown" };
}
export interface AskSparkCropOptions {
  projectId: string; crops: unknown; resolveImage: (id: string) => AskSparkImage | undefined; signal: AbortSignal;
  uploadAsset?: (projectId: string, upload: AskSparkCropUpload, signal: AbortSignal) => Promise<Asset>;
  listAssets?: (projectId: string, signal: AbortSignal) => Promise<Asset[]>;
}
export const askSparkCropLimits = { count: 16, bytes: 512 * 1024, side: 8192, pixels: 16_777_216 };

/** All rectangles and source identities are validated before preparing or uploading any asset. */
export function validateCropRequests(value: unknown, resolveImage: AskSparkCropOptions["resolveImage"]): { crop: AskSparkCrop; source: AskSparkImage }[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > askSparkCropLimits.count) throw new Error("Provide between 1 and 16 named crops in one batch.");
  const names = new Set<string>();
  return value.map(item => {
    const crop = parseCropRequest(item);
    const nameKey = crop.name.toLowerCase();
    if (names.has(nameKey)) throw new Error("Every crop in a batch must have a unique asset name.");
    names.add(nameKey);
    const source = resolveImage(crop.sourceImageId);
    if (!source || source.id !== crop.sourceImageId) throw new Error("A source image is no longer available in this conversation. Attach and send it again before cropping.");
    validateSource(source); validateBox(crop.box, source.width, source.height);
    return { crop, source };
  });
}

export function parseCropRequest(value: unknown): AskSparkCrop {
  if (!value || typeof value !== "object") throw new Error("Each crop needs a source image ID, asset name and pixel rectangle.");
  const crop = value as AskSparkCrop;
  if (typeof crop.sourceImageId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(crop.sourceImageId)) throw new Error("Use an image ID from this conversation, not an image URL.");
  if (typeof crop.name !== "string" || !crop.name.trim() || crop.name.length > 120 || /[/\\:*?"<>|]/.test(crop.name) || [...crop.name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error("Asset names must contain 1 to 120 characters without paths or control characters.");
  return { sourceImageId: crop.sourceImageId, name: crop.name.trim(), box: crop.box };
}

function validateSource(source: AskSparkImage): void {
  if (!["image/png", "image/jpeg", "image/webp"].includes(source.mimeType) || typeof source.data !== "string" || !source.data || source.data.length > 7 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(source.data)) throw new Error("The retained source image is invalid. Attach and send it again.");
  if (![source.width, source.height].every(value => Number.isInteger(value) && value > 0 && value <= askSparkCropLimits.side) || source.width * source.height > askSparkCropLimits.pixels) throw new Error("The source image exceeds the supported dimensions.");
}

export function validateBox(box: AskSparkCrop["box"], width: number, height: number): void {
  if (!box || ![box.x, box.y, box.width, box.height].every(Number.isSafeInteger) || box.x < 0 || box.y < 0 || box.width < 1 || box.height < 1 || box.x + box.width > width || box.y + box.height > height) throw new Error("Crop rectangles must use whole source-image pixels and stay completely within the original image.");
}

/** Executes one approved batch: prepare first, upload in order, stop at first failure, never retry. */
export async function cropRetainedImages(options: AskSparkCropOptions): Promise<AskSparkCropReceipt> {
  const { projectId, signal } = options;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(projectId)) throw new Error("Open a project before creating image assets.");
  signal.throwIfAborted();
  const session = authSessionRevision(), selected = validateCropRequests(options.crops, options.resolveImage);
  const existing = await (options.listAssets || listProjectAssets)(projectId, signal);
  const existingNames = new Set(existing.map(asset => asset.name.trim().toLowerCase()));
  if (selected.some(({ crop }) => existingNames.has(crop.name.toLowerCase()))) throw new Error("A requested asset name already exists in this project. Choose unique names for the new crops.");
  const prepared: { crop: AskSparkCrop; upload: AskSparkCropUpload }[] = [];
  for (const { crop, source } of selected) { assertCurrent(session, signal); prepared.push({ crop, upload: await prepareCrop(source, crop, signal) }); }
  return uploadCrops(projectId, prepared, options.uploadAsset || uploadProjectAsset, session, signal);
}

async function prepareCrop(source: AskSparkImage, crop: AskSparkCrop, signal: AbortSignal): Promise<AskSparkCropUpload> {
  const image = await loadImage(source, signal);
  try {
    if (image.naturalWidth !== source.width || image.naturalHeight !== source.height) throw new Error("The source image dimensions changed. Attach and send the image again.");
    const canvas = document.createElement("canvas"); canvas.width = crop.box.width; canvas.height = crop.box.height;
    const context = canvas.getContext("2d"); if (!context) throw new Error("Image cropping is not supported by this browser.");
    context.drawImage(image, crop.box.x, crop.box.y, crop.box.width, crop.box.height, 0, 0, crop.box.width, crop.box.height);
    const blob = await abortable(canvasBlob(canvas), signal);
    if (blob.size > askSparkCropLimits.bytes) throw new Error(`Crop “${crop.name}” exceeds the 512 KiB asset limit. Choose a smaller crop.`);
    const data = await abortable(blobDataUrl(blob), signal);
    return { name: crop.name, contentType: "image/png", dataBase64: data.split(",", 2)[1] };
  } finally { image.src = ""; }
}

function loadImage(source: AskSparkImage, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const stop = () => { image.src = ""; reject(signal.reason || new DOMException("Aborted", "AbortError")); };
    const cleanup = () => signal.removeEventListener("abort", stop);
    image.onload = () => { cleanup(); resolve(image); };
    image.onerror = () => { cleanup(); reject(new Error("The retained source image could not be decoded.")); };
    if (signal.aborted) { stop(); return; }
    signal.addEventListener("abort", stop, { once: true });
    image.src = `data:${source.mimeType};base64,${source.data}`;
  });
}

async function uploadCrops(projectId: string, prepared: { crop: AskSparkCrop; upload: AskSparkCropUpload }[], upload: NonNullable<AskSparkCropOptions["uploadAsset"]>, session: number, signal: AbortSignal): Promise<AskSparkCropReceipt> {
  const created: AskSparkCropAsset[] = [];
  for (const [index, item] of prepared.entries()) {
    let dispatched = false;
    try {
      assertCurrent(session, signal); dispatched = true;
      const asset = await upload(projectId, item.upload, signal);
      created.push({ index, sourceImageId: item.crop.sourceImageId, requestedName: item.crop.name, asset });
    } catch (reason) {
      const rejected = !dispatched || reason instanceof ApiError && reason.status >= 400 && reason.status < 500;
      return { status: created.length ? "partial" : signal.aborted ? "cancelled" : "failed", requested: prepared.length, created,
        failed: { index, name: item.crop.name, outcome: rejected ? "rejected" : "unknown" }, notAttempted: prepared.slice(index + 1).map(value => value.crop.name),
        error: `${reason instanceof Error ? reason.message : "The asset upload did not complete."}${rejected ? "" : " The upload may have succeeded. Inspect the asset library before retrying."}` };
    }
  }
  return { status: "completed", requested: prepared.length, created, notAttempted: [] };
}

function assertCurrent(session: number, signal: AbortSignal): void { signal.throwIfAborted(); if (session !== authSessionRevision()) throw new Error("The signed-in session changed. Send a new request before creating assets."); }

async function listProjectAssets(projectId: string, signal: AbortSignal): Promise<Asset[]> {
  const response = await authenticatedFetch(apiUrl("/assets", projectId), { signal });
  const result = await response.json(); assertAuthResponseCurrent(response);
  if (!response.ok || !Array.isArray(result)) throw new ApiError("The project asset library could not be read.", response.status);
  return result as Asset[];
}

export async function uploadProjectAsset(projectId: string, upload: AskSparkCropUpload, signal: AbortSignal): Promise<Asset> {
  const response = await authenticatedFetch(apiUrl("/assets", projectId), { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(upload) });
  const result = await response.json();
  if (response.status !== 401) assertAuthResponseCurrent(response);
  if (!response.ok) throw new ApiError(typeof result?.error === "string" ? result.error : "The asset upload failed.", response.status);
  if (!result || !/^[a-f0-9]{64}$/.test(result.id) || typeof result.name !== "string") throw new Error("The asset upload returned an unexpected receipt.");
  return result as Asset;
}
