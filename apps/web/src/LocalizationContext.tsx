import { runtimeText } from "./runtimeText";
import { createContext, useContext, useMemo, useState } from "react";
import type { PropsWithChildren } from "react";
import type { Project, TranslationCatalog } from "./types";
import "./localization.css";
const context = createContext<{ catalog?: TranslationCatalog; locale?: string }>({});
export function LocalizationProvider({ catalog, locale, children }: PropsWithChildren<{ catalog?: TranslationCatalog; locale?: string }>) {
  const value = useMemo(() => ({ catalog, locale }), [catalog, locale]);
  return <context.Provider value={value}>{children}</context.Provider>;
}
export function useLocalization() { return useContext(context); }

/** The URL language supports application-only launchers; selections remain local to this browser/project. */
export function useLocaleSelection(project: Project | null | undefined) {
  const [selection, setSelection] = useState<{ projectId: string; locale: string } | null>(null);
  const catalog = project?.localization;
  let stored: string | null = null;
  if (project && typeof window !== "undefined") {
    try { stored = new URLSearchParams(window.location.search).get("lang") || localStorage.getItem(`sparkstudio.locale.${project.id}`); } catch { /* Browser storage can be unavailable. */ }
  }
  const wanted = selection?.projectId === project?.id ? selection?.locale : stored;
  const locale = wanted && catalog?.locales.includes(wanted) ? wanted : catalog?.defaultLocale ?? "en";
  function setLocale(next: string) {
    if (!project || !catalog?.locales.includes(next)) return;
    setSelection({ projectId: project.id, locale: next });
    try { localStorage.setItem(`sparkstudio.locale.${project.id}`, next); } catch { /* The current page can still change language. */ }
  }
  return { locale, setLocale };
}
export function LocaleSelector({ catalog, locale, onChange }: { catalog?: TranslationCatalog; locale: string; onChange: (value: string) => void }) {
  if (!catalog) return null;
  return <label className="locale-selector">{runtimeText(catalog, locale, "language", "Language")}<select value={locale} onChange={event => onChange(event.target.value)}>{catalog.locales.map(value => <option key={value} value={value}>{value}</option>)}</select></label>;
}
