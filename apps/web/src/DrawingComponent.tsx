import type { CSSProperties, SVGProps } from "react";
import { resolveDrawingComponent } from "./drawingComponents";
import type { CanvasComponent } from "./types";
import "./drawingComponents.css";

type DrawingProps = {
  component: CanvasComponent;
  preview: boolean;
  interactionLocked?: boolean;
  onNavigate: (screenId: string) => void;
  onOpenPopup?: (component: CanvasComponent) => void;
};
type DrawingPaint = Pick<SVGProps<SVGElement>, "stroke" | "strokeWidth" | "fill" | "strokeLinecap" | "strokeLinejoin" | "vectorEffect">;

const names: Record<string, string> = {
  line: "Line", rectangle: "Rectangle", ellipse: "Ellipse", polyline: "Polyline", pipe: "Pipe", equipmentSymbol: "Equipment",
};
const safeDimension = (value: number) => Number.isFinite(value) && value > 0 ? Math.min(value, 100000) : 1;
const hexColor = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;

/** Keep geometry and its physical stroke inside the authored box at any angle. */
export function drawingLayout(width: number, height: number, strokeWidth: number, rotation: number, caption: boolean) {
  width = safeDimension(width);
  height = safeDimension(height);
  const captionHeight = caption ? Math.min(24, height * .25) : 0;
  const graphicHeight = Math.max(.1, height - captionHeight);
  // Very small boxes still show a bounded mark instead of an oversized stroke.
  const stroke = Math.max(.1, Math.min(Number.isFinite(strokeWidth) ? strokeWidth : 2, Math.min(width, graphicHeight) * .4));
  const padding = Math.min(stroke / 2 + 1, Math.min(width, graphicHeight) * .4);
  const innerWidth = Math.max(.1, width - padding * 2);
  const innerHeight = Math.max(.1, graphicHeight - padding * 2);
  const angle = Number.isFinite(rotation) ? rotation % 360 : 0;
  const radians = angle * Math.PI / 180;
  const cosine = Math.abs(Math.cos(radians)), sine = Math.abs(Math.sin(radians));
  const scale = Math.min(1, innerWidth / (innerWidth * cosine + innerHeight * sine), innerHeight / (innerWidth * sine + innerHeight * cosine));
  return { width, height, graphicHeight, captionHeight, stroke, innerWidth, innerHeight, scale,
    transform: `translate(${width / 2} ${graphicHeight / 2}) rotate(${angle}) scale(${scale}) translate(${-innerWidth / 2} ${-innerHeight / 2})` };
}

/** Original schematic symbols, composed only of bounded SVG primitives. */
function Equipment({ symbol, paint }: { symbol: "pump" | "valve" | "motor"; paint: DrawingPaint }) {
  if (symbol === "valve") return <>
    <path {...paint} fill="none" d="M5 55H20M80 55H95M50 50V22M36 22H64" />
    <path {...paint} fillOpacity={.18} d="M20 34L50 55L20 76ZM80 34L50 55L80 76Z" />
    <circle {...paint} cx={50} cy={55} r={4} />
  </>;
  if (symbol === "motor") return <>
    <path {...paint} fill="none" d="M8 50H22M78 50H94M31 79V85H69V79" />
    <rect {...paint} fillOpacity={.18} x={22} y={25} width={56} height={54} rx={12} />
    <path {...paint} fill="none" d="M34 63V40L50 57L66 40V63M35 19H65" />
  </>;
  return <>
    <path {...paint} fill="none" d="M5 53H22M72 38H94V53H78M31 80H69" />
    <circle {...paint} fillOpacity={.18} cx={50} cy={53} r={28} />
    <path {...paint} fill="none" d="M40 36L65 53L40 70ZM40 77L35 80M60 77L65 80" />
  </>;
}

export default function DrawingComponent({ component, preview, interactionLocked = false, onNavigate, onOpenPopup }: DrawingProps) {
  const model = resolveDrawingComponent(component);
  const { type, props } = component;
  const text = typeof props.text === "string" ? props.text : "";
  const label = text || (type === "equipmentSymbol" ? `${model.symbol[0].toUpperCase()}${model.symbol.slice(1)}` : names[type]);
  if (!model.available) return <div className={`drawing-component drawing-${type} drawing-unavailable`} role="status" aria-label={`${label}: Graphic unavailable`}>
    {text && <span className="drawing-caption">{text}</span>}
    <strong>Graphic unavailable</strong><span className="drawing-diagnostic">{model.diagnostic}</span>
  </div>;

  // Route labels remain accessible without moving their authored endpoints.
  const visibleCaption = type === "equipmentSymbol" && Boolean(text);
  const layout = drawingLayout(component.width, component.height, model.strokeWidth, model.rotation, visibleCaption);
  const accent = typeof props.color === "string" && hexColor.test(props.color) ? props.color : "var(--component-accent, var(--accent, #0ea5e9))";
  const state = type === "pipe" ? model.flowing ? `Flowing ${model.flowReverse ? "reverse" : "forward"}` : "Stopped"
    : type === "equipmentSymbol" ? model.active ? "Active" : "Inactive" : "";
  const accessibleLabel = `${label}${state ? `: ${state}` : ""}`;
  const paint: DrawingPaint = {
    stroke: type === "equipmentSymbol" && model.active ? accent : model.strokeColor,
    strokeWidth: layout.stroke, fill: model.fillColor, strokeLinecap: "round", strokeLinejoin: "round", vectorEffect: "non-scaling-stroke",
  };
  const points = model.points.map(point => `${point.x * layout.innerWidth / 100},${point.y * layout.innerHeight / 100}`).join(" ");
  const symbolSize = Math.min(layout.innerWidth, layout.innerHeight);
  const graphic = <>
    <svg className="drawing-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <g className="drawing-geometry" transform={layout.transform}>
        {type === "rectangle" ? <rect {...paint} width={layout.innerWidth} height={layout.innerHeight} rx={Math.min(layout.innerWidth, layout.innerHeight) * model.cornerRadius / 100} />
          : type === "ellipse" ? <ellipse {...paint} cx={layout.innerWidth / 2} cy={layout.innerHeight / 2} rx={layout.innerWidth / 2} ry={layout.innerHeight / 2} />
          : type === "equipmentSymbol" ? <g data-equipment-symbol={model.symbol} transform={`translate(${(layout.innerWidth - symbolSize) / 2} ${(layout.innerHeight - symbolSize) / 2}) scale(${symbolSize / 100})`}>
            <Equipment symbol={model.symbol} paint={paint} />
          </g>
          : <>
            <polyline {...paint} fill="none" points={points} />
            {type === "pipe" && model.fillColor !== "none" && <polyline {...paint} className="drawing-pipe-interior" fill="none" stroke={model.fillColor} strokeWidth={layout.stroke * .65} points={points} />}
            {type === "pipe" && model.flowing && <polyline {...paint} className={`drawing-pipe-flow${preview ? " drawing-flow-animated" : ""}${model.flowReverse ? " drawing-flow-reverse" : ""}`} fill="none" stroke={accent}
              strokeWidth={layout.stroke * .4} strokeDasharray={`${Math.max(2, layout.stroke)} ${Math.max(2, layout.stroke)}`} points={points}
              style={{ "--drawing-flow-offset": `${-2 * Math.max(2, layout.stroke)}px` } as CSSProperties} />}
          </>}
      </g>
    </svg>
    {visibleCaption && <span className="drawing-caption" style={{ height: layout.captionHeight }}>{text}</span>}
  </>;
  const navigation = type === "equipmentSymbol" && (props.action === "navigate" || props.action === "openPopup");
  const className = `drawing-component drawing-${type}${model.active && type === "equipmentSymbol" ? " drawing-active" : ""}`;
  if (navigation) return <button type="button" className={`${className} drawing-action`} aria-label={accessibleLabel}
    style={{ pointerEvents: preview ? "auto" : "none" }}
    disabled={!preview || interactionLocked} tabIndex={preview ? 0 : -1}
    onClick={() => {
      if (!preview || interactionLocked) return;
      if (props.action === "openPopup") onOpenPopup?.(component);
      else onNavigate(props.targetScreenId || "");
    }}>{graphic}</button>;
  return <div className={className} role="img" aria-label={accessibleLabel}>{graphic}</div>;
}
