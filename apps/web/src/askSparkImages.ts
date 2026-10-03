export interface AskSparkImage { id: string; name: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; data: string; preview: string; width: number; height: number }
export const askSparkImageLimits = { count: 4, bytes: 5 * 1024 * 1024, encoded: 12 * 1024 * 1024 };
const supported = new Set(["image/png", "image/jpeg", "image/webp"]);
export function imageAttachmentError(images: Pick<AskSparkImage, "data">[], incomingBytes: number, mimeType: string): string | undefined {
  if (!supported.has(mimeType)) return "Choose a PNG, JPEG, or WebP image.";
  if (images.length >= askSparkImageLimits.count) return "Attach up to four images to one message.";
  if (incomingBytes <= 0 || incomingBytes > askSparkImageLimits.bytes) return "Each image must be at most 5 MiB.";
  if (images.reduce((sum, image) => sum + image.data.length, 0) + Math.ceil(incomingBytes / 3) * 4 > askSparkImageLimits.encoded) return "The combined images are too large. Remove an image or use smaller files.";
}
function imageData(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("The image could not be read.")); reader.onload = () => resolve(String(reader.result).split(",", 2)[1]); reader.readAsDataURL(file); }); }
export function validImageSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/png") return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (mimeType === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mimeType === "image/webp") return String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return false;
}
function imageDimensions(url: string): Promise<{ width: number; height: number }> { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => { if (image.naturalWidth > 8192 || image.naturalHeight > 8192 || image.naturalWidth * image.naturalHeight > 16_777_216) reject(new Error("Use an image no larger than 8,192 pixels per side and 16 megapixels.")); else resolve({ width: image.naturalWidth, height: image.naturalHeight }); }; image.onerror = () => reject(new Error("This file is not a readable image.")); image.src = url; }); }
export async function prepareAskSparkImage(file: File, existing: AskSparkImage[]): Promise<AskSparkImage> {
  const problem = imageAttachmentError(existing, file.size, file.type); if (problem) throw new Error(problem);
  if (!validImageSignature(new Uint8Array(await file.slice(0, 12).arrayBuffer()), file.type)) throw new Error("The image format does not match its file type.");
  const preview = URL.createObjectURL(file);
  try { const dimensions = await imageDimensions(preview); return { id: crypto.randomUUID(), name: file.name || "Pasted image", mimeType: file.type as AskSparkImage["mimeType"], data: await imageData(file), preview, ...dimensions }; }
  catch (reason) { URL.revokeObjectURL(preview); throw reason; }
}
