export interface CameraStream { getTracks(): { stop(): void }[] }
export interface CameraSnapshot {
  phase: "idle" | "requesting" | "live" | "capturing" | "captured" | "error";
  imageUrl: string;
  error: string;
}
export interface CameraServices {
  open: () => Promise<CameraStream>;
  capture: () => Promise<Blob>;
  createUrl: (image: Blob) => string;
  revokeUrl: (url: string) => void;
  attach: (stream: CameraStream | null) => void;
}
export const emptyCameraSnapshot = (): CameraSnapshot => ({ phase: "idle", imageUrl: "", error: "" });
export function cameraInputValue(value: unknown): value is string {
  if (value === "") return true;
  if (typeof value !== "string" || value.length > 4096 || !/^blob:https?:\/\/[^\s]+$/.test(value)) return false;
  try {
    const address = new URL(value.slice(5));
    return !address.username && !address.password && !address.search && !address.hash && address.pathname.length > 1;
  } catch { return false; }
}
function cameraError(reason: unknown): string {
  const name = reason && typeof reason === "object" && "name" in reason ? String(reason.name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera permission was denied. Allow camera access in your browser, then try again.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "No camera was found on this computer.";
  if (name === "NotReadableError" || name === "TrackStartError") return "The camera is in use or unavailable. Close other camera applications, then try again.";
  return reason instanceof Error ? reason.message : "The camera could not be started. Try again.";
}

/** A capture belongs to this mounted component; stale permission/capture results cannot publish it. */
export class ComputerCameraController {
  private active = false;
  private revision = 0;
  private stream: CameraStream | null = null;
  private ownedUrl = "";
  private snapshot = emptyCameraSnapshot();
  private readonly services: CameraServices;
  private readonly changed: (snapshot: CameraSnapshot) => void;
  private readonly input: (value: string) => void;
  constructor(services: CameraServices, changed: (snapshot: CameraSnapshot) => void, input: (value: string) => void) {
    this.services = services; this.changed = changed; this.input = input;
  }
  activate() { this.active = true; }
  private update(next: Partial<CameraSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    if (this.active) this.changed(this.snapshot);
  }
  private stop() {
    if (this.stream) for (const track of this.stream.getTracks()) track.stop();
    this.stream = null;
    this.services.attach(null);
  }
  private release() { if (this.ownedUrl) this.services.revokeUrl(this.ownedUrl); this.ownedUrl = ""; }
  reset(emit = true) {
    this.revision++; this.stop(); this.release();
    if (emit && this.active) this.input("");
    this.update(emptyCameraSnapshot());
  }
  synchronize(value: unknown) {
    if (this.ownedUrl && value !== this.ownedUrl) this.reset(false);
    else if (!this.ownedUrl && this.active && typeof value === "string" && value) this.input("");
  }
  suspend() {
    this.revision++; this.stop();
    if (!this.ownedUrl) this.update(emptyCameraSnapshot());
  }
  deactivate() { this.active = false; this.reset(false); }
  async start() {
    if (!this.active || this.snapshot.phase === "requesting" || this.snapshot.phase === "capturing") return;
    this.reset();
    const revision = this.revision;
    this.update({ phase: "requesting" });
    try {
      const stream = await this.services.open();
      if (!this.active || revision !== this.revision) { for (const track of stream.getTracks()) track.stop(); return; }
      this.stream = stream; this.services.attach(stream); this.update({ phase: "live" });
    } catch (reason) {
      if (this.active && revision === this.revision) { this.stop(); this.update({ phase: "error", error: cameraError(reason) }); }
    }
  }
  async capture() {
    if (!this.active || !this.stream || this.snapshot.phase !== "live") return;
    const revision = this.revision;
    this.update({ phase: "capturing", error: "" });
    try {
      const image = await this.services.capture();
      if (!this.active || revision !== this.revision) return;
      if (image.type !== "image/png" || !image.size || image.size > 1024 * 1024) throw new Error("The camera did not return a valid PNG photo. Try again.");
      const url = this.services.createUrl(image);
      if (!cameraInputValue(url) || !url) { this.services.revokeUrl(url); throw new Error("The photo could not be opened in this browser."); }
      this.release(); this.ownedUrl = url; this.stop();
      this.input(url); this.update({ phase: "captured", imageUrl: url });
    } catch (reason) {
      if (this.active && revision === this.revision) this.update({ phase: "live", error: cameraError(reason) });
    }
  }
}
