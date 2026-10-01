import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import { ComputerCameraController, emptyCameraSnapshot } from "./computerCameraModel";
import "./computerCamera.css";

function capturePhoto(video: HTMLVideoElement | null): Promise<Blob> {
  if (!video || !video.videoWidth || !video.videoHeight || video.readyState < 2) return Promise.reject(new Error("The camera is still loading. Wait a moment, then capture your photo."));
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 320;
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("This browser cannot capture a photo."));
  const side = Math.min(video.videoWidth, video.videoHeight);
  context.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, 320, 320);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("The photo could not be captured. Try again.")), "image/png"));
}

export default function ComputerCamera({ caption, value, interactive, disabled, onChange, onCommit }: {
  caption: string; value: unknown; interactive: boolean; disabled: boolean;
  onChange: (url: string) => void; onCommit?: (url: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onChange, onCommit }); callbacks.current = { onChange, onCommit };
  const [snapshot, setSnapshot] = useState(emptyCameraSnapshot);
  const [ready, setReady] = useState(false);
  const controller = useRef<ComputerCameraController | null>(null);
  if (!controller.current) controller.current = new ComputerCameraController({
    open: async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("Camera access requires HTTPS or localhost and a supported browser.");
      return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 640 } } });
    },
    capture: () => capturePhoto(video.current),
    createUrl: blob => URL.createObjectURL(blob), revokeUrl: url => URL.revokeObjectURL(url),
    attach: stream => { setReady(false); if (video.current) video.current.srcObject = stream as MediaStream | null; },
  }, setSnapshot, url => { callbacks.current.onChange(url); if (url) callbacks.current.onCommit?.(url); });
  useEffect(() => { const capture = controller.current!; capture.activate(); return () => capture.deactivate(); }, []);
  useEffect(() => controller.current!.synchronize(value), [value]);
  useEffect(() => { if (!interactive || disabled) controller.current!.suspend(); }, [interactive, disabled]);
  const busy = snapshot.phase === "requesting" || snapshot.phase === "capturing";
  if (!interactive) return <div className="media-placeholder"><Icon name="camera" size={28} /><strong>{caption}</strong><span>Start the camera and capture a photo in Preview or the operator application.</span></div>;
  return <section className="render-computer-camera" aria-label={caption}>
    <strong className="computer-camera-caption">{caption}</strong>
    <div className="computer-camera-image">
      <video ref={video} autoPlay muted playsInline aria-label={`${caption} live preview`} onLoadedData={() => setReady(true)} hidden={snapshot.phase !== "live" && snapshot.phase !== "capturing"} />
      {snapshot.imageUrl ? <img src={snapshot.imageUrl} alt={`${caption} captured photo`} draggable={false} /> : snapshot.phase !== "live" && snapshot.phase !== "capturing" && <div className="computer-camera-placeholder"><Icon name="camera" size={32} /><span>{snapshot.phase === "requesting" ? "Waiting for camera access…" : "Capture your photo"}</span></div>}
    </div>
    {snapshot.error && <p role="alert" className="computer-camera-error">{snapshot.error}</p>}
    <div className="computer-camera-actions">
      {snapshot.phase === "live" || snapshot.phase === "capturing" ? <><button type="button" className="button primary small" disabled={disabled || busy || !ready} onClick={() => void controller.current!.capture()}>{snapshot.phase === "capturing" ? "Capturing…" : "Capture photo"}</button><button type="button" className="button small" disabled={disabled || busy} onClick={() => controller.current!.reset()}>Cancel camera</button></> : <button type="button" className="button primary small" disabled={disabled || busy} onClick={() => void controller.current!.start()}>{snapshot.imageUrl ? "Retake photo" : snapshot.phase === "requesting" ? "Starting…" : "Start camera"}</button>}
      {snapshot.imageUrl && <button type="button" className="button small" disabled={disabled || busy} onClick={() => controller.current!.reset()}>Clear photo</button>}
      {snapshot.phase === "requesting" && <button type="button" className="button small" disabled={disabled} onClick={() => controller.current!.reset()}>Cancel camera</button>}
    </div>
  </section>;
}
