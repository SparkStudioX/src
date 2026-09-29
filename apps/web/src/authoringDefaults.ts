export interface AuthoringDefaults {
  screenWidth: number;
  screenHeight: number;
  templateWidth: number;
  templateHeight: number;
  gridSize: number;
}

export const defaultAuthoring: Readonly<AuthoringDefaults> = Object.freeze({ screenWidth: 1200, screenHeight: 760, templateWidth: 600, templateHeight: 400, gridSize: 8 });
const keys = Object.keys(defaultAuthoring) as (keyof AuthoringDefaults)[];

export function authoringDefaultsError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Authoring defaults must be an object.";
  const values = value as Record<string, unknown>;
  if (Object.keys(values).length !== keys.length || Object.keys(values).some(key => !keys.includes(key as keyof AuthoringDefaults)))
    return "Authoring defaults must contain only the four document dimensions and grid size.";
  for (const key of keys) {
    const number = values[key];
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < (key === "gridSize" ? 0 : 1) || number > (key === "gridSize" ? 128 : 8192))
      return key === "gridSize" ? "Grid size must be a whole number from 0 to 128 pixels." : "Document dimensions must be whole numbers from 1 to 8,192 pixels.";
  }
  return undefined;
}

/** Defaults affect new documents only; legacy documents retain their authored size. */
export function projectAuthoringDefaults(project: { authoringDefaults?: unknown }): AuthoringDefaults {
  return project.authoringDefaults !== undefined && !authoringDefaultsError(project.authoringDefaults)
    ? { ...project.authoringDefaults as AuthoringDefaults } : { ...defaultAuthoring };
}

export function newDocumentDimensions(project: { authoringDefaults?: unknown }, kind: "screen" | "template") {
  const settings = projectAuthoringDefaults(project);
  return kind === "screen" ? { width: settings.screenWidth, height: settings.screenHeight } : { width: settings.templateWidth, height: settings.templateHeight };
}
