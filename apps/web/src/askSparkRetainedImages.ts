import type { AskSparkImage } from "./askSparkImages";

/** Only this open conversation's user-supplied images can become crop sources. Never persisted in browser storage. */
export class AskSparkRetainedImages {
  private readonly images = new Map<string, AskSparkImage>();
  assertCapacity(incoming: AskSparkImage[]): void {
    const next = new Map(this.images);
    incoming.forEach(image => next.set(image.id, image));
    if (next.size > 12 || [...next.values()].reduce((sum, image) => sum + image.data.length, 0) > 32 * 1024 * 1024)
      throw new Error("This conversation's retained images reached their limit (12 images or 32 MiB). Start a new conversation before attaching more images.");
  }
  add(images: AskSparkImage[]): void { this.assertCapacity(images); images.forEach(image => this.images.set(image.id, image)); }
  get(id: string): AskSparkImage {
    const image = this.images.get(id);
    if (!image) throw new Error("That image is not retained in this browser conversation. Paste it again before requesting crops.");
    return image;
  }
  ids(): string[] { return [...this.images.keys()]; }
  clear(): void { this.images.clear(); }
}
