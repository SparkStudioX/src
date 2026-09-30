export interface ScriptSyntaxResult { valid: boolean; message?: string; line?: number; column?: number; endLine?: number; endColumn?: number }

/** Syntax checking compiles source but never invokes it or imports authored libraries. */
export async function checkScriptSyntax(language: "python" | "javascript", code: string,
  python: (code: string, signal: AbortSignal) => Promise<ScriptSyntaxResult>, signal: AbortSignal): Promise<ScriptSyntaxResult> {
  signal.throwIfAborted();
  if (code.length > 65536) throw new Error("Use at most 65,536 characters.");
  if (language === "python") return python(code, signal);
  try {
    new Function("event", "inputs", "parameters", "app", "session", `"use strict"; return (async () => {\n${code}\n})();`);
    return { valid: true };
  } catch (reason) { return { valid: false, message: reason instanceof Error ? reason.message : String(reason) }; }
}

export function scriptSyntaxMessage(result: ScriptSyntaxResult): string {
  if (result.valid) return "No syntax errors. Code was not run.";
  const location = result.line ? `Line ${result.line}${result.column ? `, column ${result.column}` : ""}: ` : "";
  return location + (result.message || "Invalid syntax.");
}

/** Checks for an old buffer may finish, but can never annotate its replacement. */
export class ScriptSyntaxCheck {
  private generation = 0;
  private controller?: AbortController;
  cancel() { ++this.generation; this.controller?.abort(); this.controller = undefined; }
  async run(execute: (signal: AbortSignal) => Promise<ScriptSyntaxResult>): Promise<ScriptSyntaxResult | undefined> {
    this.cancel(); const generation = this.generation;
    const controller = new AbortController(); this.controller = controller;
    try {
      const result = await execute(controller.signal);
      return generation === this.generation && !controller.signal.aborted ? result : undefined;
    } catch (error) {
      if (generation === this.generation && !controller.signal.aborted) throw error;
      return undefined;
    } finally { if (generation === this.generation) this.controller = undefined; }
  }
}
