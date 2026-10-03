import { toCanvas } from "html-to-image";
import { authHeaders, authenticatedFetch, assertAuthResponseCurrent } from "./api";
import { authSessionRevision } from "./authSession";

export interface AskSparkCapturedCanvas { data: string; mimeType: "image/png"; name: string; width: number; height: number; canvasWidth: number; canvasHeight: number }
export const askSparkVisualLimits = { bytes: 5 * 1024 * 1024, side: 2048, pixels: 4_194_304, nodes: 10_000 };
const excluded = ".canvas-component-selection,.canvas-group-bounds,.canvas-marquee,.canvas-precision-guides,.component-selection-label,.resize-handle,.empty-canvas,[data-ask-spark-private],input[type=password],input[type=hidden],input[autocomplete=current-password],input[autocomplete=new-password],iframe";

export function captureDimensions(width: number, height: number): { width: number; height: number } {
  if (![width, height].every(value => Number.isFinite(value) && value > 0 && value <= 32_768)) throw new Error("The canvas dimensions cannot be captured.");
  const scale = Math.min(1, askSparkVisualLimits.side / width, askSparkVisualLimits.side / height, Math.sqrt(askSparkVisualLimits.pixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export function includeCaptureNode(node: HTMLElement): boolean { return !(node instanceof Element) || !node.matches(excluded); }

/** Captures the rendered application DOM, not a reconstruction of component definitions. */
export async function captureDesignerCanvas(element: HTMLElement, signal: AbortSignal): Promise<AskSparkCapturedCanvas> {
  signal.throwIfAborted();
  if (!element.isConnected || !element.matches(".screen-canvas")) throw new Error("Open a canvas screen or template before capturing it.");
  if (element.querySelectorAll("*").length > askSparkVisualLimits.nodes) throw new Error("This canvas is too large to capture. Open a smaller screen or template.");
  const session = authSessionRevision(), canvasWidth = element.offsetWidth, canvasHeight = element.offsetHeight;
  const dimensions = captureDimensions(canvasWidth, canvasHeight);
  const deadline = new AbortController(), abort = () => deadline.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => deadline.abort(new Error("Canvas capture timed out. Check its images and fonts, then try again.")), 20_000);
  try {
    const captured = await abortable(renderCanvas(element, canvasWidth, canvasHeight, dimensions, deadline.signal), deadline.signal);
    if (session !== authSessionRevision()) throw new Error("The signed-in session changed during canvas capture.");
    signal.throwIfAborted();
    return { ...captured, canvasWidth, canvasHeight, name: "Current canvas.png", mimeType: "image/png" };
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

async function renderCanvas(element: HTMLElement, width: number, height: number, output: { width: number; height: number }, signal: AbortSignal) {
  await abortable(element.ownerDocument.fonts.ready, signal);
  await validateCanvasImages(element, signal);
  const fontEmbedCSS = await embeddedFonts(element, signal);
  const canvas = await toCanvas(element, {
    width, height, canvasWidth: output.width, canvasHeight: output.height, pixelRatio: 1, skipAutoScale: true,
    filter: includeCaptureNode, fontEmbedCSS, includeQueryParams: true,
    fetchRequestInit: { credentials: "same-origin", mode: "same-origin", redirect: "error", headers: authHeaders(), signal },
    style: { transform: "none", transformOrigin: "top left", left: "0", top: "0", margin: "0", outline: "none", ...(element.classList.contains("snap-grid") ? { backgroundImage: "none" } : {}) },
    onImageErrorHandler: () => { throw new Error("A canvas image could not be captured. Check its loading state and access permissions."); },
  });
  signal.throwIfAborted();
  return boundedPng(canvas, signal);
}

async function validateCanvasImages(element: HTMLElement, signal: AbortSignal): Promise<void> {
  const nodes = [element, ...element.querySelectorAll<HTMLElement>("*")].filter(node => !node.closest(excluded));
  const urls = new Set<string>();
  for (const node of nodes) {
    if (node instanceof HTMLImageElement) {
      if (!node.complete || !node.naturalWidth) await abortable(node.decode(), signal);
      if (node.currentSrc || node.src) urls.add(node.currentSrc || node.src);
    }
    const style = getComputedStyle(node);
    for (const value of [style.backgroundImage, style.maskImage]) for (const url of cssUrls(value)) urls.add(url);
  }
  if (urls.size > 128) throw new Error("The canvas contains too many distinct image resources to capture.");
  for (const url of urls) {
    signal.throwIfAborted();
    const source = localResource(url, element.ownerDocument.baseURI);
    if (!source.startsWith("data:")) await readResource(source, signal);
  }
}

function cssUrls(css: string): string[] { return [...css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)].map(match => match[2]); }
function localResource(value: string, base: string): string {
  if (value.startsWith("data:") || value.startsWith("blob:")) return value;
  const url = new URL(value, base);
  if (url.origin !== window.location.origin || !["http:", "https:"].includes(url.protocol)) throw new Error("Canvas capture supports images and fonts served by this gateway. External resources must be imported first.");
  return url.href;
}

async function readResource(url: string, signal: AbortSignal): Promise<Blob> {
  const response = await authenticatedFetch(url, { signal, redirect: "error" });
  if (!response.ok) throw new Error("A canvas image or font is unavailable. Check its loading state and access permissions.");
  const blob = await response.blob(); assertAuthResponseCurrent(response);
  if (blob.size > 5 * 1024 * 1024) throw new Error("A canvas resource exceeds the capture size limit.");
  return blob;
}

/** Embed only already-loaded, same-origin font-face rules; never fetch arbitrary imported stylesheets. */
async function embeddedFonts(element: HTMLElement, signal: AbortSignal): Promise<string> {
  const families = new Set([element, ...element.querySelectorAll<HTMLElement>("*")].flatMap(node => getComputedStyle(node).fontFamily.split(",").map(font => font.trim().replace(/["']/g, "").toLowerCase())));
  const rules: CSSFontFaceRule[] = [];
  const collect = (items: CSSRuleList) => { for (const rule of items) { if (rule instanceof CSSFontFaceRule) rules.push(rule); else if ("cssRules" in rule) collect((rule as CSSGroupingRule).cssRules); } };
  for (const sheet of element.ownerDocument.styleSheets) {
    if (sheet.href) localResource(sheet.href, element.ownerDocument.baseURI);
    try { collect(sheet.cssRules); } catch { throw new Error("A canvas stylesheet cannot be read for font capture."); }
  }
  const embedded: string[] = [];
  for (const rule of rules.filter(item => families.has(item.style.fontFamily.replace(/["']/g, "").toLowerCase()))) {
    let css = rule.cssText;
    for (const url of cssUrls(css)) {
      const source = localResource(url, rule.parentStyleSheet?.href || element.ownerDocument.baseURI);
      const data = source.startsWith("data:") ? source : await blobDataUrl(await readResource(source, signal));
      css = css.split(url).join(data);
    }
    embedded.push(css);
  }
  return embedded.join("\n");
}

async function boundedPng(original: HTMLCanvasElement, signal: AbortSignal) {
  let canvas = original;
  for (let attempt = 0; attempt < 6; attempt++) {
    signal.throwIfAborted();
    const blob = await canvasBlob(canvas);
    if (blob.size <= askSparkVisualLimits.bytes) return { data: (await blobDataUrl(blob)).split(",", 2)[1], width: canvas.width, height: canvas.height };
    const next = document.createElement("canvas"); next.width = Math.max(1, Math.floor(canvas.width * 0.75)); next.height = Math.max(1, Math.floor(canvas.height * 0.75));
    const context = next.getContext("2d"); if (!context) throw new Error("Canvas capture is not supported by this browser.");
    context.drawImage(canvas, 0, 0, next.width, next.height); canvas = next;
  }
  throw new Error("The canvas image exceeds the capture size limit.");
}

export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> { return new Promise((resolve, reject) => { try { canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("This canvas could not be encoded as PNG.")), "image/png"); } catch { reject(new Error("This canvas contains an image the browser cannot export. Import external images into the project first.")); } }); }
export function blobDataUrl(blob: Blob): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("The captured image could not be read.")); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(blob); }); }
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> { return new Promise((resolve, reject) => { const abort = () => reject(signal.reason || new DOMException("Aborted", "AbortError")); if (signal.aborted) { abort(); return; } signal.addEventListener("abort", abort, { once: true }); promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)); }); }
