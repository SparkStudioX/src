const shapes: Record<string, React.ReactNode> = {
  spark: <path d="m13 2-8 12h7l-1 8 8-12h-7z" />,
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  design: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M3 9h18M9 9v12" />
    </>
  ),
  plug: (
    <>
      <path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0zm6 9v5" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" />
    </>
  ),
  code: (
    <>
      <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16" />
    </>
  ),
  settings: (
    <>
      <path d="M12 3v4m0 10v4M3 12h4m10 0h4M5.6 5.6l2.8 2.8m7.2 7.2 2.8 2.8M5.6 18.4l2.8-2.8m7.2-7.2 2.8-2.8" />
      <circle cx="12" cy="12" r="5" />
    </>
  ),
  arrow: <path d="m9 5 7 7-7 7" />,
  down: <path d="m6 9 6 6 6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  play: <path d="m8 4 13 8-13 8z" />,
  stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
  save: (
    <>
      <path d="M5 3h12l4 4v14H3V3zM7 3v6h10V3M7 21v-8h10v8" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="3" width="18" height="13" rx="2" />
      <path d="M12 16v5m-5 0h10" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 10 5-10 5L2 8zm-10 9 10 5 10-5M2 16l10 5 10-5" />
    </>
  ),
  tag: (
    <>
      <path d="M3 3h8l10 10-8 8L3 11z" />
      <circle cx="7.5" cy="7.5" r="1" />
    </>
  ),
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 6 6" />
    </>
  ),
  text: (
    <>
      <path d="M4 5h16M12 5v15M8 20h8" />
    </>
  ),
  value: (
    <>
      <path d="m10 3-4 18M18 3l-4 18M3 9h18M2 15h18" />
    </>
  ),
  gauge: (
    <>
      <path d="M4 18a9 9 0 1 1 16 0M12 12l5-5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  "led-display": <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 8h4v8H6zm8 0h4v8h-4m-8-4h4m4 0h4" /></>,
  "progress-bar": <><rect x="2" y="7" width="20" height="10" rx="2" /><path d="M5 10v4m3-4v4m3-4v4m3-4v4" /></>,
  "cylindrical-tank": <><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v14c0 4 14 4 14 0V5M5 13c0 4 14 4 14 0" /></>,
  "level-indicator": <><rect x="7" y="2" width="9" height="20" rx="1" /><path d="M9 20V10h5v10M18 5h3m-3 7h3m-3 7h3" /></>,
  thermometer: <><path d="M9 14.5V5a3 3 0 0 1 6 0v9.5a5 5 0 1 1-6 0M12 7v10m5-11h3m-3 4h3" /><circle cx="12" cy="18" r="2" /></>,
  "drawing-line": <><path d="m4 18 16-12" /><circle cx="4" cy="18" r="1.5" /><circle cx="20" cy="6" r="1.5" /></>,
  "drawing-rectangle": <rect x="3" y="5" width="18" height="14" rx="1" />,
  "drawing-ellipse": <ellipse cx="12" cy="12" rx="9" ry="7" />,
  "drawing-polyline": <><path d="M3 19h8V5h10" /><circle cx="3" cy="19" r="1.5" /><circle cx="11" cy="5" r="1.5" /><circle cx="21" cy="5" r="1.5" /></>,
  "drawing-pipe": <><path d="M2 16h7V5h13M2 21h12V10h8M4 14v9M20 3v9" /></>,
  "equipment-symbol": <><circle cx="12" cy="11" r="7" /><path d="m9 7 7 4-7 4zM2 11h3m14 0h3M8 17l-2 4h12l-2-4" /></>,
  button: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="4" />
      <path d="M9 12h6" />
    </>
  ),
  table: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M9 9v12" />
    </>
  ),
  list: <><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></>,
  tree: <><rect x="3" y="3" width="6" height="5" rx="1" /><rect x="14" y="10" width="7" height="5" rx="1" /><rect x="14" y="18" width="7" height="4" rx="1" /><path d="M6 8v12h8M6 12.5h8" /></>,
  folder: <path d="M3 5h7l2 3h9v12H3z" />,
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V4H4v12h4" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 8a9 9 0 0 0-15-3L2 8m0-6v6h6M4 16a9 9 0 0 0 15 3l3-3m0 6v-6h-6" />
    </>
  ),
  external: (
    <>
      <path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7" />
    </>
  ),
  link: (
    <>
      <path d="m9 15 6-6m-5-3 2-2a5 5 0 0 1 7 7l-2 2M7 11l-2 2a5 5 0 0 0 7 7l2-2" />
    </>
  ),
  move: (
    <>
      <path d="M12 2v20M2 12h20m-13-7 3-3 3 3m-6 14 3 3 3-3M5 9l-3 3 3 3m14-6 3 3-3 3" />
    </>
  ),
  undo: (
    <>
      <path d="M3 4v6h6M3 10a9 9 0 1 1 2 9" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-11v1" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  shield: (
    <>
      <path d="m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5" />
    </>
  ),
  activity: <path d="M2 12h5l3-9 4 18 3-9h5" />,
  worker: (
    <>
      <path d="M5 9a7 7 0 0 1 14 0H5z" fill="currentColor" fillOpacity=".18" />
      <path d="M3 9h18M10 3v4m4-4v4" />
      <path d="M7 10v2a5 5 0 0 0 10 0v-2M3 22v-2c0-3 4-5 9-5s9 2 9 5v2" />
      <path d="m8 16 4 4 4-4M7 19v3m10-3v3" />
    </>
  ),
  forklift: (
    <>
      <path d="M2 13h5V6h6v11H2z" fill="currentColor" fillOpacity=".16" />
      <path d="M5 6h10M9 9v4h4M17 3v17h5M20 6v11h3" />
      <circle cx="5" cy="19" r="2" fill="currentColor" fillOpacity=".2" />
      <circle cx="13" cy="19" r="2" fill="currentColor" fillOpacity=".2" />
      <path d="M7 19h4M15 17h2" />
    </>
  ),
  warehouse: (
    <>
      <path d="m2 9 10-6 10 6v12H2z" fill="currentColor" fillOpacity=".12" />
      <path d="M6 21V10h12v11M6 14h12M6 17h12M10 10v11m4-11v11" />
    </>
  ),
  pallet: (
    <>
      <rect x="5" y="3" width="14" height="14" rx="1" fill="currentColor" fillOpacity=".15" />
      <path d="M10 3v5h4V3M2 18h20v3H2zm4 0v3m12-3v3" />
    </>
  ),
  route: (
    <>
      <circle cx="5" cy="5" r="2" fill="currentColor" fillOpacity=".2" />
      <circle cx="19" cy="19" r="2" fill="currentColor" fillOpacity=".2" />
      <path d="M7 5h10a4 4 0 0 1 0 8H7a3 3 0 0 0 0 6h8m-3-3 3 3-3 3" />
    </>
  ),
};

export const iconNames = Object.keys(shapes);

export default function Icon({
  name,
  size = 18,
  className = "",
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {shapes[name] || shapes.grid}
    </svg>
  );
}
