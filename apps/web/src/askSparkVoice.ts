import { useCallback, useEffect, useRef, useState } from "react";
import { askSparkError, askSparkRequest } from "./askSparkClient";

type VoicePhase = "idle" | "requesting" | "recording" | "transcribing";
interface Recording { recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; cancelled: boolean; size: number; timer: number }
const maximumAudioBytes = 8 * 1024 * 1024;
export function audioBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(new Error("The recording could not be read."));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]); reader.readAsDataURL(blob);
  });
}
export function preferredAudioMime(): string | undefined {
  return ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"].find(value => MediaRecorder.isTypeSupported(value));
}

export function useAskSparkVoice(onTranscript: (text: string) => void) {
  const [phase, setPhase] = useState<VoicePhase>("idle"), [error, setError] = useState("");
  const active = useRef<Recording | null>(null), request = useRef<AbortController | null>(null), generation = useRef(0), callback = useRef(onTranscript), acquiring = useRef(false);
  callback.current = onTranscript;
  const release = useCallback((capture: Recording) => { window.clearTimeout(capture.timer); capture.stream.getTracks().forEach(track => track.stop()); }, []);
  const cancel = useCallback(() => {
    generation.current++; acquiring.current = false; request.current?.abort(); request.current = null;
    const capture = active.current;
    if (capture) { capture.cancelled = true; release(capture); if (capture.recorder.state !== "inactive") capture.recorder.stop(); }
    active.current = null; setPhase("idle");
  }, [release]);
  useEffect(() => () => { generation.current++; request.current?.abort(); const capture = active.current; if (capture) { capture.cancelled = true; release(capture); if (capture.recorder.state !== "inactive") capture.recorder.stop(); } }, [release]);
  const transcribe = useCallback(async (capture: Recording, run: number) => {
    release(capture); if (active.current === capture) active.current = null;
    if (capture.cancelled || generation.current !== run) return;
    const controller = new AbortController(); request.current = controller; setPhase("transcribing");
    try {
      const blob = new Blob(capture.chunks, { type: capture.recorder.mimeType || "audio/webm" });
      if (!blob.size) throw new Error("No audio was recorded. Try again.");
      const audio = await audioBase64(blob);
      const result = await askSparkRequest<{ text: string }>("/transcribe", "POST", { audio, mimeType: blob.type }, controller.signal);
      if (generation.current === run) { callback.current(result.text); setPhase("idle"); }
    } catch (reason) { if (generation.current === run) { setError(askSparkError(reason)); setPhase("idle"); } }
    finally { if (request.current === controller) request.current = null; }
  }, [release]);
  const start = useCallback(async () => {
    if (active.current || request.current || acquiring.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setError("Microphone recording requires HTTPS or localhost and a browser with audio recording support."); return; }
    const run = ++generation.current; acquiring.current = true; setPhase("requesting"); setError(""); let pendingStream: MediaStream | undefined;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); pendingStream = stream;
      if (generation.current !== run) { stream.getTracks().forEach(track => track.stop()); return; }
      const mimeType = preferredAudioMime();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const capture: Recording = { recorder, stream, chunks: [], cancelled: false, size: 0, timer: 0 };
      active.current = capture;
      recorder.ondataavailable = event => { capture.size += event.data.size; if (capture.size > maximumAudioBytes) { capture.cancelled = true; release(capture); if (recorder.state !== "inactive") recorder.stop(); active.current = null; setError("Recording is too large. Try a shorter message."); setPhase("idle"); } else capture.chunks.push(event.data); };
      recorder.onstop = () => { void transcribe(capture, run); };
      recorder.onerror = () => { capture.cancelled = true; release(capture); active.current = null; setError("Microphone recording failed. Try again."); setPhase("idle"); };
      capture.timer = window.setTimeout(() => { if (recorder.state !== "inactive") recorder.stop(); }, 60_000);
      recorder.start(500); pendingStream = undefined; setPhase("recording");
    } catch (reason) { pendingStream?.getTracks().forEach(track => track.stop()); if (generation.current === run) { active.current = null; setError(askSparkError(reason)); setPhase("idle"); } }
    finally { if (generation.current === run) acquiring.current = false; }
  }, [release, transcribe]);
  const stop = () => { const recorder = active.current?.recorder; if (recorder && recorder.state !== "inactive") recorder.stop(); };
  return { phase, error, start, stop, cancel, busy: phase !== "idle" };
}
