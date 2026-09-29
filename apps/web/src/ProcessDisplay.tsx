import { useId } from "react";
import type { CSSProperties } from "react";
import { resolveProcessDisplay } from "./processDisplays";
import type { ProcessDisplayValue } from "./processDisplays";
import type { CanvasComponent, RuntimeParameters } from "./types";
import "./processDisplays.css";

// Seven polygon segments per digit. These shapes are authored locally and need no font or network asset.
const segments = [
  "9,4 31,4 35,8 31,12 9,12 5,8",
  "33,11 37,15 37,31 33,35 29,31 29,15",
  "33,39 37,43 37,59 33,63 29,59 29,43",
  "9,62 31,62 35,66 31,70 9,70 5,66",
  "7,39 11,43 11,59 7,63 3,59 3,43",
  "7,11 11,15 11,31 7,35 3,31 3,15",
  "9,33 31,33 35,37 31,41 9,41 5,37",
];
const lit: Record<string, string> = { "0": "012345", "1": "12", "2": "01346", "3": "01236", "4": "1256", "5": "02356", "6": "023456", "7": "012", "8": "0123456", "9": "012356", "-": "6" };

function LedDigits({ value }: { value: string }) {
  let offset = 4;
  const characters = [...value].map((character, index) => {
    const x = offset; offset += character === "." ? 14 : 44;
    return character === "." ? <circle key={index} className="led-segment on" cx={x + 5} cy={66} r={4} />
      : <g key={index} transform={`translate(${x},0)`}>{segments.map((points, segment) => <polygon key={segment} points={points} className={`led-segment${lit[character]?.includes(String(segment)) ? " on" : ""}`} />)}</g>;
  });
  return <svg className="process-led-digits" viewBox={`0 0 ${offset + 4} 76`} preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">{characters}</svg>;
}

function Tank({ model, clipId }: { model: ProcessDisplayValue; clipId: string }) {
  const level = 204 - model.ratio! * 176;
  const outline = "M28 28 C28 5 152 5 152 28 L152 188 C152 211 28 211 28 188 Z";
  return <svg className="process-vessel" viewBox="0 0 180 224" aria-hidden="true" focusable="false">
    <defs><clipPath id={clipId}><path d={outline} /></clipPath></defs>
    <path className="process-empty" d={outline} />
    <g clipPath={`url(#${clipId})`}>
      <rect className="process-fill" x={28} y={level} width={124} height={204 - level} />
      {model.ratio! > 0 && <ellipse className="process-fill-surface" cx={90} cy={level} rx={62} ry={13} />}
    </g>
    <path className="process-outline" d={outline} />
    <ellipse className="process-outline process-rim" cx={90} cy={28} rx={62} ry={17} />
    <path className="process-highlight" d="M38 45V183" />
  </svg>;
}

function Level({ model }: { model: ProcessDisplayValue }) {
  const horizontal = model.orientation === "horizontal";
  return <div className={`process-level ${horizontal ? "horizontal" : "vertical"}`}>
    <div className="process-level-track"><div className="process-level-fill" style={horizontal ? { width: `${model.ratio! * 100}%` } : { height: `${model.ratio! * 100}%` }} /></div>
    <div className="process-level-ticks" aria-hidden="true">{Array.from({ length: 11 }, (_, index) => <span key={index} className={index % 5 === 0 ? "major" : "minor"} style={horizontal ? { left: `${index * 10}%` } : { bottom: `${index * 10}%` }} />)}</div>
    <div className="process-level-labels" aria-hidden="true">{[0, 0.5, 1].map(fraction => <span key={fraction} style={horizontal ? { left: `${fraction * 100}%` } : { bottom: `${fraction * 100}%` }}>{(model.min! + (model.max! - model.min!) * fraction).toFixed(model.decimals)}</span>)}</div>
  </div>;
}

function Thermometer({ model, clipId }: { model: ProcessDisplayValue; clipId: string }) {
  const level = 173 - model.ratio! * 144;
  const outline = "M50 176 V30 A14 14 0 0 1 78 30 V176 A28 28 0 1 1 50 176 Z";
  return <svg className="process-thermometer-svg" viewBox="0 0 144 240" aria-hidden="true" focusable="false">
    <defs><clipPath id={clipId}><path d={outline} /></clipPath></defs>
    <path className="process-empty" d={outline} />
    <rect className="process-fill" x={34} y={level} width={60} height={234 - level} clipPath={`url(#${clipId})`} />
    <path className="process-outline" d={outline} />
    {Array.from({ length: 11 }, (_, index) => <path key={index} className="process-tick" d={`M90 ${173 - index * 14.4}h${index % 5 === 0 ? 15 : 8}`} />)}
    <path className="process-highlight" d="M57 42V170" />
    <circle className="process-bulb-highlight" cx={55} cy={204} r={7} />
  </svg>;
}

export default function ProcessDisplay({ component, parameters }: { component: CanvasComponent; parameters: RuntimeParameters }) {
  // Always allocate before the availability branch so changing quality cannot reorder hooks.
  const clipId = `process-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const model = resolveProcessDisplay(component, parameters);
  const title = Object.hasOwn(component.props.bindings ?? {}, "text") ? component.props.text ?? ""
    : component.props.text || ({ ledDisplay: "LED display", progressBar: "Progress", cylindricalTank: "Tank level", levelIndicator: "Level", thermometer: "Temperature" } as Record<string, string>)[component.type];
  if (!model.available) return <div className={`process-display process-${component.type} process-unavailable`} role="status" aria-label={`${title}: Value unavailable`}>
    <span className="process-caption">{title}</span><strong>Value unavailable</strong><span className="process-diagnostic">{model.diagnostic}</span>
  </div>;
  const led = component.type === "ledDisplay";
  const measurement = `${model.formatted}${model.unit ? ` ${model.unit}` : ""}`;
  const rangeMessage = model.rangeStatus === "below" ? "Below range" : model.rangeStatus === "above" ? "Above range" : "";
  const valueText = `${measurement}${rangeMessage ? `, ${rangeMessage.toLowerCase()}` : ""}${model.showPercent ? `, ${model.percent} fill` : ""}`;
  return <div className={`process-display process-${component.type} process-${model.orientation}${model.rangeStatus ? " process-out-of-range" : ""}`}
    role={led ? "img" : component.type === "progressBar" ? "progressbar" : "meter"}
    aria-label={led ? `${title}: ${valueText}` : title}
    aria-valuemin={led ? undefined : model.min} aria-valuemax={led ? undefined : model.max}
    aria-valuenow={led ? undefined : Math.max(model.min!, Math.min(model.max!, model.value))}
    aria-valuetext={led ? undefined : valueText}
    data-process-value={model.value} data-process-ratio={model.ratio}
    style={{ "--process-ratio": `${(model.ratio ?? 0) * 100}%` } as CSSProperties}>
    <span className="process-caption">{title}</span>
    <div className="process-graphic" aria-hidden="true">
      {led ? <LedDigits value={model.formatted} />
        : component.type === "progressBar" ? <div className="process-progress-track"><div className="process-progress-fill" /></div>
        : component.type === "cylindricalTank" ? <Tank model={model} clipId={clipId} />
        : component.type === "thermometer" ? <Thermometer model={model} clipId={clipId} />
        : <Level model={model} />}
    </div>
    {led ? <><span className="process-accessible-value">{measurement}</span>{model.unit && <span className="process-unit" aria-hidden="true">{model.unit}</span>}</>
      : (model.showValue || model.showPercent || model.rangeStatus) && <div className="process-readout">
        {(model.showValue || model.rangeStatus) && <strong className="process-measurement">{measurement}</strong>}
        {model.showPercent && <span className="process-percent">{model.percent} fill</span>}
      </div>}
    {rangeMessage && <span className="process-range-warning">{rangeMessage}</span>}
  </div>;
}
