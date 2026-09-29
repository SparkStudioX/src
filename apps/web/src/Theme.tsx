import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemePreference = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";
const storageKey = "sparkstudio.theme.v1";
const mediaQuery = "(prefers-color-scheme: dark)";

function normalizePreference(value: unknown): ThemePreference {
  return value === "dark" || value === "system" ? value : "light";
}

function readPreference(): ThemePreference {
  try {
    return normalizePreference(window.localStorage.getItem(storageKey));
  } catch {
    // Restricted storage must not prevent the designer or runtime from opening.
    return "light";
  }
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== "system") return preference;
  return typeof window.matchMedia === "function" && window.matchMedia(mediaQuery).matches
    ? "dark"
    : "light";
}

function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolved;
  return resolved;
}

/** Called before React renders so saved preferences apply to the first app frame. */
export function initializeTheme(): void {
  applyTheme(readPreference());
}

interface ThemeContextValue {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(preference));

  useLayoutEffect(() => {
    setResolvedTheme(applyTheme(preference));
  }, [preference]);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== storageKey && event.key !== null) return;
      const next = normalizePreference(event.newValue);
      applyTheme(next);
      setPreferenceState(next);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (preference !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(mediaQuery);
    const onChange = () => setResolvedTheme(applyTheme("system"));
    // Re-read after subscribing in case the OS preference changed during render.
    media.addEventListener("change", onChange);
    onChange();
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    const valid = normalizePreference(next);
    setResolvedTheme(applyTheme(valid));
    setPreferenceState(valid);
    try {
      window.localStorage.setItem(storageKey, valid);
    } catch {
      // Continue with an in-memory choice when storage is unavailable or full.
    }
  }, []);

  const value = useMemo(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme, setPreference],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function ThemePicker({ className = "" }: { className?: string }) {
  const theme = useContext(ThemeContext);
  const id = useId();
  if (!theme) throw new Error("ThemePicker requires ThemeProvider.");
  return (
    <label className={`theme-picker ${className}`.trim()} htmlFor={id}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <circle cx="12" cy="12" r="8" />
        <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" />
      </svg>
      <span>Theme</span>
      <select
        id={id}
        aria-label="Appearance theme"
        title={`Current appearance: ${theme.resolvedTheme}`}
        value={theme.preference}
        onChange={(event) => theme.setPreference(normalizePreference(event.target.value))}
      >
        <option value="light">Light</option>
        <option value="dark">Dark</option>
        <option value="system">System</option>
      </select>
    </label>
  );
}
