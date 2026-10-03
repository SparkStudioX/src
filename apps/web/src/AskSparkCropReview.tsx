import { askSparkCropLimits, parseCropRequest, validateBox } from "./askSparkImageCrops";
import type { AskSparkCrop } from "./askSparkImageCrops";
import "./AskSparkCropReview.css";

export interface AskSparkCropPreviewImage { preview: string; width: number; height: number; name: string }
export interface AskSparkCropReviewProps { crops: unknown; resolveImage: (id: string) => AskSparkCropPreviewImage | undefined }
interface CropPreview { crop: AskSparkCrop; source: AskSparkCropPreviewImage; scale: number }

export function cropPreview(value: unknown, resolveImage: AskSparkCropReviewProps["resolveImage"]): CropPreview {
  const crop = parseCropRequest(value), source = resolveImage(crop.sourceImageId);
  if (!source) throw new Error("This image is no longer available. Send it again before approving crops.");
  if (![source.width, source.height].every(dimension => Number.isInteger(dimension) && dimension > 0 && dimension <= askSparkCropLimits.side) || source.width * source.height > askSparkCropLimits.pixels) throw new Error("The source image dimensions are invalid.");
  if (!/^(blob:|data:image\/(?:png|jpeg|webp);base64,)/.test(source.preview)) throw new Error("Only images sent in this conversation can be previewed.");
  validateBox(crop.box, source.width, source.height);
  return { crop, source, scale: Math.min(1, 144 / crop.box.width, 96 / crop.box.height) };
}

/** A read-only preview of the exact named rectangles covered by one batch approval. */
export function AskSparkCropReview({ crops, resolveImage }: AskSparkCropReviewProps) {
  if (!Array.isArray(crops) || crops.length < 1 || crops.length > askSparkCropLimits.count) return <p className="ask-spark-crop-error">A crop batch needs between 1 and 16 images.</p>;
  return <section className="ask-spark-crop-review" aria-label="Image crops to create">
    <p>These crops will be added to the project asset library after approval. Coordinates use the original image pixels.</p>
    <div className="ask-spark-crop-grid">{crops.map((value, index) => <CropTile key={index} value={value} index={index} resolveImage={resolveImage} />)}</div>
  </section>;
}

function CropTile({ value, index, resolveImage }: { value: unknown; index: number; resolveImage: AskSparkCropReviewProps["resolveImage"] }) {
  let preview: CropPreview;
  try { preview = cropPreview(value, resolveImage); }
  catch (error) { return <figure className="ask-spark-crop-tile"><figcaption>Crop {index + 1}</figcaption><p className="ask-spark-crop-error">{error instanceof Error ? error.message : "This crop cannot be previewed."}</p></figure>; }
  const { crop, source, scale } = preview;
  return <figure className="ask-spark-crop-tile">
    <div className="ask-spark-crop-frame"><div className="ask-spark-crop-clip" style={{ width: crop.box.width * scale, height: crop.box.height * scale }}>
      <img src={source.preview} alt={`Proposed crop: ${crop.name}`} draggable={false} style={{ width: source.width * scale, height: source.height * scale, left: -crop.box.x * scale, top: -crop.box.y * scale }} />
    </div></div>
    <figcaption><strong>{crop.name}</strong><span>{crop.box.width} × {crop.box.height} px</span><span>x {crop.box.x}, y {crop.box.y} · {source.name}</span></figcaption>
  </figure>;
}
