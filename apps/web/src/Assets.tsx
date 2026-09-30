import { useRef, useState } from "react";
import { api, apiUrl } from "./api";
import Icon from "./Icon";
import type { Asset } from "./types";

export default function AssetPicker({
  assets,
  selected,
  onSelect,
  onUploaded,
  notify,
}: {
  assets: Asset[];
  selected?: string;
  onSelect: (id: string) => void;
  onUploaded: (asset: Asset) => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const current = assets.find((asset) => asset.id === selected);
  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      if (file.size > 512 * 1024)
        throw new Error("Choose an image no larger than 512 KiB.");
      const contentType =
        file.type ||
        (/\.png$/i.test(file.name)
          ? "image/png"
          : /\.jpe?g$/i.test(file.name)
            ? "image/jpeg"
            : /\.webp$/i.test(file.name)
              ? "image/webp"
              : "");
      if (!["image/png", "image/jpeg", "image/webp"].includes(contentType))
        throw new Error("Choose a PNG, JPEG, or WebP image.");
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("Unable to read this image."));
        reader.readAsDataURL(file);
      });
      const asset = await api<Asset>("/assets", "POST", {
        name: file.name,
        contentType,
        dataBase64: data,
      });
      onUploaded(asset);
      onSelect(asset.id);
      notify("Image added to the local asset library.");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <div className="asset-picker">
      <label className="field">
        <span>Local image</span>
        <select
          aria-label="Local image"
          value={selected || ""}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">Choose an image…</option>
          {selected && !current && (
            <option value={selected}>
              Saved image ({selected.slice(0, 8)})
            </option>
          )}
          {assets.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.name} · {asset.width} × {asset.height}
            </option>
          ))}
        </select>
      </label>
      {current && (
        <div className="asset-preview">
          <img src={apiUrl(`/assets/${current.id}`)} alt={current.name} />
          <span>
            {current.width} × {current.height} ·{" "}
            {(current.size / 1024).toFixed(1)} KiB
          </span>
        </div>
      )}
      <label className="field"><span>Image library</span><button
        className="button asset-upload"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        <Icon name="upload" size={14} />
        {busy ? "Uploading…" : "Upload local image"}
      </button></label>
      <input
        ref={input}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        onChange={(event) => void upload(event.target.files?.[0])}
      />
      <p className="template-property-note">
        PNG, JPEG, or WebP · up to 512 KiB. Images stay on this gateway and work
        offline. Uploads create immutable assets.
      </p>
    </div>
  );
}
