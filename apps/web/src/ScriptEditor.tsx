import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { autocompletion } from "@codemirror/autocomplete";
import type { Completion } from "@codemirror/autocomplete";
import { HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { tags } from "@lezer/highlight";
import "./scriptEditor.css";

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--script-keyword)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--script-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--script-number)" },
  { tag: tags.comment, color: "var(--muted)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: "var(--accent)" },
]);

export default function ScriptEditor({ value, language, onChange, onRun, onSave, readOnly = false, completions = [] }: {
  value: string;
  language: "python" | "javascript";
  onChange: (value: string) => void;
  onRun?: () => void;
  onSave?: () => void;
  readOnly?: boolean;
  completions?: Completion[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const options = useRef({ value, onChange, onRun, onSave, completions });
  options.current = { value, onChange, onRun, onSave, completions };
  const editable = useRef(new Compartment());
  const externalUpdate = useRef(false);
  const [position, setPosition] = useState({ line: 1, column: 1 });

  useLayoutEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: options.current.value,
        extensions: [
          basicSetup,
          language === "python" ? python() : javascript(),
          indentUnit.of(language === "python" ? "    " : "  "),
          syntaxHighlighting(highlight),
          editable.current.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
          EditorView.contentAttributes.of({ "aria-label": language === "python" ? "Python source editor" : "JavaScript source editor", "aria-describedby": "script-editor-keys", spellcheck: "false" }),
          Prec.highest(keymap.of([
            { key: "Mod-s", run: () => { options.current.onSave?.(); return true; }, preventDefault: true, stopPropagation: true },
            { key: "Mod-Enter", run: () => { options.current.onRun?.(); return true; }, preventDefault: true, stopPropagation: true },
            indentWithTab,
          ])),
          autocompletion({ override: [(context) => {
            const word = context.matchBefore(/[A-Za-z_][\w.]*/);
            if (!word && !context.explicit) return null;
            return { from: word?.from ?? context.pos, options: options.current.completions, validFor: /^[\w.]*$/ };
          }] }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !externalUpdate.current) options.current.onChange(update.state.doc.toString());
            if (update.docChanged || update.selectionSet) {
              const at = update.state.selection.main.head;
              const line = update.state.doc.lineAt(at);
              setPosition({ line: line.number, column: at - line.from + 1 });
            }
          }),
        ],
      }),
    });
    view.current = editor;
    return () => { view.current = null; editor.destroy(); };
  }, [language]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    externalUpdate.current = true;
    try { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } }); }
    finally { externalUpdate.current = false; }
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly, language]);

  return <div className="source-editor" onKeyDown={(event) => {
    // Editor history/search shortcuts must not reach the surrounding canvas.
    if (event.ctrlKey || event.metaKey) event.stopPropagation();
  }}>
    <div className="source-editor-host" ref={host} />
    <div className="source-editor-status"><span>{language === "python" ? "Python 3" : "JavaScript"} · Ln {position.line}, Col {position.column}</span><span id="script-editor-keys">Ctrl+F find · Ctrl+Space complete · Tab indent · Esc, Tab leaves editor</span></div>
  </div>;
}
