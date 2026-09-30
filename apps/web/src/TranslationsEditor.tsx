import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CanvasComponent, Project, TranslationCatalog } from "./types";
import { captionTokens, localeCode, translationReferences, validateProjectLocalization } from "./localization";
import "./visualStyles.css";
import "./localization.css";

export function ComponentTranslationAssignment({ component, catalog, onChange, onManage }: {
  component: CanvasComponent; catalog?: TranslationCatalog; onChange: (patch: CanvasComponent["props"]) => void; onManage: () => void;
}) {
  const fieldId = useId();
  if (component.type === "passwordInput") return null;
  function compatible(key: string) {
    try { return JSON.stringify(captionTokens(component.props.text ?? "")) === JSON.stringify(captionTokens(catalog!.messages[key][catalog!.defaultLocale])); } catch { return false; }
  }
  const bound = Boolean(component.props.bindings?.text || component.props.queryBindings?.text);
  return <div className="inspector-section visual-style-assignment"><h3>Caption translation</h3>
    <div className="property-sheet-row" data-property="textKey"><label htmlFor={fieldId}>Translation key</label><div className="property-sheet-value"><select id={fieldId} value={component.props.textKey ?? ""} onChange={event => onChange({ textKey: event.target.value || undefined })}>
      <option value="">Authored text</option>
      {component.props.textKey && (!catalog || !Object.hasOwn(catalog.messages, component.props.textKey)) && <option value={component.props.textKey}>Missing translation</option>}
      {Object.keys(catalog?.messages ?? {}).map(key => <option key={key} value={key} disabled={!compatible(key)}>{key}{compatible(key) ? "" : " (parameter mismatch)"}</option>)}
    </select></div><span aria-hidden="true" /></div>
    <div className="property-sheet-row"><label>Translation catalog</label><div className="property-sheet-value"><button className="button" type="button" onClick={onManage}>Manage translations</button></div><span aria-hidden="true" /></div>
    <small>{bound ? "The Text binding takes precedence over caption translation." : "Translates the caption only. Authored text remains the final fallback; values and choices stay unchanged."}</small>
  </div>;
}

export default function TranslationsEditor({ project, onApply, onClose }: {
  project: Project; onApply: (catalog: TranslationCatalog, snapshot: string) => void; onClose: () => void;
}) {
  const id = useId(), dialog = useRef<HTMLDialogElement>(null), snapshot = useRef(JSON.stringify(project));
  const [catalog, setCatalog] = useState<TranslationCatalog>(() => structuredClone(project.localization ?? { defaultLocale: "en", locales: ["en", "es"], messages: {} }));
  const [key, setKey] = useState(Object.keys(catalog.messages)[0] ?? "");
  const [newKey, setNewKey] = useState(""), [newLocale, setNewLocale] = useState(""), [error, setError] = useState("");
  const messages = Object.hasOwn(catalog.messages, key) ? catalog.messages[key] : undefined;
  const references = messages ? translationReferences(project, key) : [];
  let validation = "";
  try { validateProjectLocalization({ ...project, localization: catalog }); } catch (cause) { validation = cause instanceof Error ? cause.message : "Invalid translations."; }
  const canAddKey = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(newKey) && newKey.trim() === newKey && !Object.hasOwn(catalog.messages, newKey) && Object.keys(catalog.messages).length < 500;
  const canAddLocale = localeCode.test(newLocale) && newLocale.trim() === newLocale && !catalog.locales.includes(newLocale) && catalog.locales.length < 8;
  useEffect(() => {
    const element = dialog.current, previousFocus = document.activeElement; element?.showModal();
    return () => { element?.close(); if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); };
  }, []);
  const patch = (next: TranslationCatalog) => { setCatalog(next); setError(""); };
  function removeLocale(locale: string) {
    if (locale === catalog.defaultLocale) return;
    patch({ ...catalog, locales: catalog.locales.filter(item => item !== locale), messages: Object.fromEntries(Object.entries(catalog.messages).map(([message, translations]) => [message, Object.fromEntries(Object.entries(translations).filter(([language]) => language !== locale))])) });
  }
  return createPortal(<dialog ref={dialog} className="visual-styles-dialog translations-dialog" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && ["s", "z", "y"].includes(event.key.toLowerCase())) event.preventDefault(); }}>
    <header><div><h2 id={`${id}-title`}>Project translations</h2><p>Offline reusable captions; missing translations use the default language with a visible note.</p></div><button type="button" aria-label="Close translations" onClick={onClose}>×</button></header>
    <div className="translation-languages">
      <label>Default language<select value={catalog.defaultLocale} onChange={event => patch({ ...catalog, defaultLocale: event.target.value })}>{catalog.locales.map(locale => <option key={locale}>{locale}</option>)}</select></label>
      <label>Add language<input value={newLocale} maxLength={8} placeholder="fr or fr-CA" onChange={event => setNewLocale(event.target.value)} /></label><button type="button" className="button" disabled={!canAddLocale} onClick={() => { patch({ ...catalog, locales: [...catalog.locales, newLocale] }); setNewLocale(""); }}>Add language</button>
      <div>{catalog.locales.map(locale => <span key={locale}>{locale}<button type="button" disabled={locale === catalog.defaultLocale} aria-label={`Remove language ${locale} and its translations`} title="Remove this language and its translations from the staged catalog" onClick={() => removeLocale(locale)}>×</button></span>)}</div>
      <p>Supports en, es, fr, de, it and pt with optional region codes. Removing a language removes its staged translations. Cancel restores the project catalog.</p>
    </div>
    <div className="visual-styles-body"><nav aria-label="Translation messages">
      <label>New message key<input value={newKey} maxLength={64} onChange={event => setNewKey(event.target.value)} placeholder="station.caption" /></label>
      <button type="button" className="button" disabled={!canAddKey} onClick={() => { patch({ ...catalog, messages: { ...catalog.messages, [newKey]: { [catalog.defaultLocale]: "New caption" } } }); setKey(newKey); setNewKey(""); }}>Add message</button>
      {Object.keys(catalog.messages).map(message => <button type="button" key={message} aria-pressed={message === key} onClick={() => setKey(message)}>{message}</button>)}
    </nav><section>{messages ? <>
      <h3>{key}</h3>
      {catalog.locales.map(locale => <label key={locale} className="translation-text">{locale}{locale === catalog.defaultLocale ? " (required default)" : " (blank uses default)"}
        <textarea rows={3} maxLength={2048} value={messages[locale] ?? ""} onChange={event => {
          const translations = { ...messages };
          if (event.target.value || locale === catalog.defaultLocale) translations[locale] = event.target.value; else delete translations[locale];
          patch({ ...catalog, messages: { ...catalog.messages, [key]: translations } });
        }} />
      </label>)}
      <p>Keep the same parameter tokens in every language and in the authored component caption. Their order may change. Input values and choice labels are outside this caption-only catalog.</p>
      <details open={references.length > 0}><summary>{references.length} component assignment{references.length === 1 ? "" : "s"}</summary><ul>{references.map(ref => <li key={`${ref.documentId}/${ref.componentId}`}>{ref.label}</li>)}</ul></details>
      <button type="button" className="button danger" disabled={references.length > 0} onClick={() => { const next = { ...catalog.messages }; delete next[key]; patch({ ...catalog, messages: next }); setKey(Object.keys(next)[0] ?? ""); }}>Delete message</button>
      {references.length > 0 && <p>Remove these component assignments before deleting the message.</p>}
    </> : <p>Add a message, provide its translations, then assign its key to a component caption.</p>}</section></div>
    <footer><p>Every message needs a translation for the selected default language. Apply is one Undo step; Save and Publish remain separate.</p>
      {(validation || error) && <p role="alert">{error || validation}</p>}
      <div><button type="button" className="button" onClick={onClose}>Cancel</button><button type="button" className="button primary" disabled={Boolean(validation || error)} onClick={() => { try { onApply(catalog, snapshot.current); } catch (cause) { setError(cause instanceof Error ? cause.message : "Translations could not be applied."); } }}>Apply translations</button></div>
    </footer>
  </dialog>, document.body);
}
