import type { CanvasComponent, Project, TranslationCatalog } from "./types";

/** Initial left-to-right language families; number/date formatting and RTL layout are separate work. */
export const localeCode = /^(?:en|es|fr|de|it|pt)(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;
const messageKey = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const own = (value: object, key: string) => Object.hasOwn(value, key);
const fail = (message: string): never => { throw new Error(message); };
export function captionTokens(text: string): string[] {
  const tokens = [...text.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]).sort();
  if (/[{}]/.test(text.replace(/\{[^{}]+\}/g, ""))) fail("Caption parameters need matching braces.");
  return tokens;
}
function sameTokens(a: string, b: string) { return JSON.stringify(captionTokens(a)) === JSON.stringify(captionTokens(b)); }

export function validateLocalization(value: unknown): asserts value is TranslationCatalog | undefined {
  if (value === undefined) return;
  if (!object(value) || Object.keys(value).some(key => !["defaultLocale", "locales", "messages"].includes(key))) fail("Localization needs only defaultLocale, locales and messages.");
  const catalog = value as Record<string, unknown>;
  if (!Array.isArray(catalog.locales) || catalog.locales.length < 1 || catalog.locales.length > 8 ||
    catalog.locales.some(locale => typeof locale !== "string" || locale.trim() !== locale || !localeCode.test(locale)) || new Set(catalog.locales).size !== catalog.locales.length)
    fail("Choose 1–8 unique en, es, fr, de, it or pt language codes, optionally with a region such as en-US or es-MX.");
  const locales = catalog.locales as string[];
  if (typeof catalog.defaultLocale !== "string" || !locales.includes(catalog.defaultLocale)) fail("The default language must be one of the declared languages.");
  if (!object(catalog.messages) || Object.keys(catalog.messages).length > 500) fail("A project can contain at most 500 translation messages.");
  let total = 0;
  for (const [key, translations] of Object.entries(catalog.messages as Record<string, unknown>)) {
    if (key.trim() !== key || !messageKey.test(key)) fail("Message keys need 1–64 letters, numbers, dots, dashes or underscores, beginning with a letter.");
    if (!object(translations) || !own(translations, catalog.defaultLocale as string) || Object.keys(translations).some(locale => !locales.includes(locale)))
      fail(`Message ${key} needs a default translation and can only contain declared languages.`);
    const entries = translations as Record<string, unknown>;
    for (const text of Object.values(entries)) {
      if (typeof text !== "string" || !text.trim() || text.length > 2048 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) fail("Translations need 1–2048 characters without control characters other than tabs and line breaks.");
      total += (text as string).length;
      if (total > 262144) fail("Translation text exceeds the project limit of 262144 characters.");
      if (!sameTokens(entries[catalog.defaultLocale as string] as string, text as string)) fail(`Every translation of ${key} must preserve its parameter tokens.`);
    }
  }
}

export function translationReferences(project: Project, key: string) {
  return [...project.screens.map(document => ({ document, kind: "Screen" })), ...(project.templates ?? []).map(document => ({ document, kind: "Template" }))]
    .flatMap(({ document, kind }) => document.components.filter(component => component.props.textKey === key)
      .map(component => ({ documentId: document.id, componentId: component.id, label: `${kind}: ${document.name} / ${component.props.text || component.id}` })));
}
export function validateProjectLocalization(project: Project): void {
  validateLocalization(project.localization);
  for (const document of [...project.screens, ...(project.templates ?? [])]) for (const component of document.components) {
    const key = component.props.textKey;
    if (key === undefined) continue;
    if (typeof key !== "string" || !project.localization || !own(project.localization.messages, key)) fail(`Caption translation is missing for ${document.name} / ${component.id}.`);
    if (component.type === "passwordInput") fail("Password controls do not support caption translation keys.");
    const defaultText = project.localization!.messages[key][project.localization!.defaultLocale];
    if (!sameTokens(component.props.text ?? "", defaultText)) fail(`Caption translation parameters must match the authored caption on ${document.name} / ${component.id}.`);
  }
}
export function applyLocalizationCatalog(project: Project, snapshot: string, localization: TranslationCatalog | undefined): Project {
  if (JSON.stringify(project) !== snapshot) fail("The project changed while this editor was open. Close it and reopen Translations to review the current draft.");
  const next = { ...project, localization: localization === undefined ? undefined : structuredClone(localization) };
  validateProjectLocalization(next);
  return next;
}

/** Localization supplies the literal caption fallback. Expression/query text bindings remain authoritative. */
export function localizeComponent(component: CanvasComponent, catalog: TranslationCatalog | undefined, requestedLocale?: string): { component: CanvasComponent; warning?: string; locale?: string } {
  const key = component.props.textKey;
  const authoredLocale = catalog && typeof catalog.defaultLocale === "string" && localeCode.test(catalog.defaultLocale) ? catalog.defaultLocale : undefined;
  if (key === undefined || component.props.bindings?.text || component.props.queryBindings?.text || component.type === "passwordInput") return { component, locale: authoredLocale };
  const authoredFallback = () => ({ component, locale: authoredLocale, warning: "Caption translation unavailable; using authored text." });
  if (!catalog || !object(catalog.messages) || !Array.isArray(catalog.locales) || typeof catalog.defaultLocale !== "string" || typeof key !== "string" || !own(catalog.messages, key)) return authoredFallback();
  const messages = catalog.messages[key];
  if (!object(messages)) return authoredFallback();
  const locale = requestedLocale ?? catalog.defaultLocale;
  const requested = catalog.locales.includes(locale) && own(messages, locale) ? messages[locale] : undefined;
  const fallback = own(messages, catalog.defaultLocale) ? messages[catalog.defaultLocale] : undefined;
  const text = requested ?? fallback;
  if (typeof text !== "string" || text.length > 2048 || !text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) return authoredFallback();
  try { if (!sameTokens(component.props.text ?? "", text)) return authoredFallback(); } catch { return authoredFallback(); }
  return { component: { ...component, props: { ...component.props, text } }, locale: requested === undefined ? catalog.defaultLocale : locale,
    ...(requested === undefined ? { warning: `Translation unavailable for ${catalog.locales.includes(locale) ? locale : "requested language"}; using ${catalog.defaultLocale}.` } : {}) };
}
