/** Generated images remain in the calling browser; no remote or data URL loads. */
export function imageUrlError(value: unknown, origin?: string): string | null {
  if (typeof value !== "string" || value.length > 4096) return "Image URL must be text up to 4096 characters.";
  if (value === "") return null;
  try {
    // eslint-disable-next-line no-control-regex -- This character filter intentionally matches control characters.
    if (!value.startsWith("blob:") || /[\s\u0000-\u001f\u007f]/.test(value)) throw new Error();
    const url = new URL(value), inner = new URL(value.slice(5));
    if (url.protocol !== "blob:" || !["http:", "https:"].includes(inner.protocol) || inner.username || inner.password
      || inner.pathname.length <= 1 || inner.search || inner.hash || url.origin !== inner.origin || url.origin === "null") throw new Error();
    if (origin !== undefined && url.origin !== new URL(origin).origin) return "Image URL must belong to this application's browser origin.";
    return null;
  } catch { return "Image URL must be empty or a local browser blob URL."; }
}

/** With no browser origin, a transient source cannot be safely rendered. */
export function transientImageUrl(value: unknown, origin?: string): string | null {
  return origin && typeof value === "string" && value !== "" && !imageUrlError(value, origin) ? value : null;
}
