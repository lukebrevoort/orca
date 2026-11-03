import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { useTopLayerActive } from "./top-layer";

export type FeedbackMediaFile = { id: string; name: string; mimeType: string; size: number; dataUrl: string };
const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm", "video/quicktime"];
const ACCEPT = TYPES.join(",");

function CaptureControls({ children, hidden }: { children: ReactNode; hidden: boolean }) {
  // When another app dialog opens during recording, keep Stop/Cancel inside
  // its accessible focus boundary. The recorder itself never moves/unmounts.
  useTopLayerActive();
  const [host, setHost] = useState<Element | null>(null);
  useLayoutEffect(() => {
    const next = document.querySelector("#orca-top-layer-root > [data-top-layer='active'] [role='dialog']")
      ?? document.getElementById("orca-top-layer-root");
    if (next !== host) setHost(next);
  });
  return host ? createPortal(<div hidden={hidden} className="feedback-capture-controls" role="region" aria-label="Screen capture controls">{children}</div>, host) : null;
}

async function paintedFrame(video: HTMLVideoElement) {
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  if (typeof video.requestVideoFrameCallback !== "function") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { video.cancelVideoFrameCallback(callback); reject(new Error("Screen capture did not produce a frame. Try again.")); }, 5000);
    const callback = video.requestVideoFrameCallback(() => { clearTimeout(timeout); resolve(); });
  });
}

function dataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read this file. Choose it again."));
    reader.readAsDataURL(blob);
  });
}
async function prepare(file: File): Promise<FeedbackMediaFile> {
  if (!TYPES.includes(file.type)) throw new Error("Choose a PNG, JPEG, WebP, MP4, WebM or MOV file.");
  if (!file.size || file.size > MAX_FILE) throw new Error("Each attachment must be between 1 byte and 10 MB.");
  let blob: Blob = file;
  // Re-encode images to omit EXIF/location metadata; never capture the page DOM.
  if (file.type.startsWith("image/")) {
    const bitmap = await createImageBitmap(file).catch(() => { throw new Error("This image could not be opened."); });
    try {
      if (bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width * bitmap.height > 32_000_000) throw new Error("Choose an image smaller than 32 megapixels and 8192 pixels per side.");
      const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext("2d"); if (!context) throw new Error("Image preview is unavailable.");
      context.drawImage(bitmap, 0, 0);
      blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Could not prepare image.")), file.type, 0.9));
    } finally { bitmap.close(); }
  }
  if (blob.size > MAX_FILE) throw new Error("The prepared image exceeds 10 MB. Choose a smaller image.");
  return { id: crypto.randomUUID(), name: file.name.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 160) || "attachment", mimeType: blob.type, size: blob.size, dataUrl: await dataURL(blob) };
}

type Props = {
  files: FeedbackMediaFile[];
  onChange: (files: FeedbackMediaFile[]) => void;
  reviewed: boolean;
  onReviewed: (value: boolean) => void;
  locked: boolean;
  onWorking: (value: boolean) => void;
  onCaptureChange: (value: boolean) => void;
};
export function FeedbackMedia({ files, onChange, reviewed, onReviewed, locked, onWorking, onCaptureChange }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [unplayable, setUnplayable] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [captureMode, setCaptureMode] = useState<"image" | "video" | null>(null);
  const [snapshotting, setSnapshotting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef<() => void>(() => {});
  const stopRecording = useRef<() => void>(() => {});
  const generation = useRef(0);
  const mounted = useRef(true);
  const latest = useRef({ files, onChange, onReviewed, onWorking, onCaptureChange });
  latest.current = { files, onChange, onReviewed, onWorking, onCaptureChange };
  const captureSupported = typeof navigator.mediaDevices?.getDisplayMedia === "function";
  const recorderType = typeof MediaRecorder === "undefined" ? undefined : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find(type => MediaRecorder.isTypeSupported(type));
  useEffect(() => {
    mounted.current = true;
    const hidden = () => { if (document.visibilityState === "hidden") cancel.current(); };
    document.addEventListener("visibilitychange", hidden);
    return () => { mounted.current = false; generation.current++; cancel.current(); latest.current.onWorking(false); latest.current.onCaptureChange(false); document.removeEventListener("visibilitychange", hidden); };
  }, []);
  useEffect(() => {
    if (!captureMode) return;
    const keyboard = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "x") {
        event.preventDefault(); if (recording) stopRecording.current(); else cancel.current();
      } else if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault(); cancel.current();
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [captureMode, recording]);
  function busy(value: boolean) { if (mounted.current) { setWorking(value); latest.current.onWorking(value); } }
  function append(next: FeedbackMediaFile[]) {
    const combined = [...latest.current.files, ...next];
    if (combined.length > 3 || combined.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL) throw new Error("Use up to 3 attachments, 20 MB total.");
    latest.current.onChange(combined); latest.current.onReviewed(false);
  }
  async function select(selected: File[]) {
    if (!selected.length || working || locked) return;
    if (selected.length + files.length > 3 || selected.reduce((sum, file) => sum + file.size, files.reduce((sum, file) => sum + file.size, 0)) > MAX_TOTAL) { setError("Use up to 3 attachments, 20 MB total."); return; }
    const version = ++generation.current;
    busy(true); setError(null);
    try {
      const prepared: FeedbackMediaFile[] = [];
      for (const file of selected) prepared.push(await prepare(file));
      if (mounted.current && version === generation.current) append(prepared);
    } catch (cause) { if (mounted.current && version === generation.current) setError(cause instanceof Error ? cause.message : "Could not prepare attachment."); }
    finally { if (version === generation.current) busy(false); }
  }
  async function capture(mode: "image" | "video") {
    if (working || locked || files.length >= 3) return;
    const version = ++generation.current;
    // Synchronously remove the composer/backdrop before requesting capture,
    // without losing the transient user activation required by the browser.
    flushSync(() => { busy(true); setError(null); setSeconds(0); setCaptureMode(mode); latest.current.onCaptureChange(true); });
    let stream: MediaStream | undefined;
    let recorder: MediaRecorder | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let discarded = false;
    let finished = false;
    const release = (endBusy = true) => {
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach(track => track.stop());
      if (mounted.current && version === generation.current) {
        setRecording(false);
        if (endBusy) { busy(false); setCaptureMode(null); setSnapshotting(false); latest.current.onCaptureChange(false); }
      }
    };
    cancel.current = () => { discarded = true; if (recorder?.state === "recording") recorder.stop(); release(); };
    try {
      // The browser asks the user to choose a surface on every invocation.
      const options = { video: { displaySurface: "browser", frameRate: { ideal: 15, max: 15 } }, audio: false,
        preferCurrentTab: true, selfBrowserSurface: "include", systemAudio: "exclude", surfaceSwitching: "exclude", monitorTypeSurfaces: "exclude" };
      stream = await navigator.mediaDevices.getDisplayMedia(options);
      if (discarded || !mounted.current || version !== generation.current) { release(); return; }
      stream.getAudioTracks().forEach(track => { track.stop(); stream!.removeTrack(track); });
      if (mode === "image") {
        const video = document.createElement("video"); video.muted = true; video.srcObject = stream;
        try {
          let frameTimeout: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([video.play(), new Promise<never>((_, reject) => { frameTimeout = setTimeout(() => reject(new Error("Screen capture did not become ready. Try again.")), 15_000); })]); }
          finally { if (frameTimeout) clearTimeout(frameTimeout); }
          if (discarded || !mounted.current || version !== generation.current) return;
          if (!video.videoWidth || !video.videoHeight) throw new Error("The selected screen could not be captured.");
          flushSync(() => setSnapshotting(true));
          await paintedFrame(video);
          if (discarded || !mounted.current || version !== generation.current) return;
          const canvas = document.createElement("canvas");
          const scale = Math.min(1, 4096 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
          canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Screenshot failed.")), "image/png"));
          release(false);
          const file = await prepare(new File([blob], "screenshot.png", { type: "image/png" }));
          if (!discarded && mounted.current && version === generation.current) append([file]);
        } finally { video.pause(); video.srcObject = null; release(); }
      } else {
        if (!recorderType) throw new Error("Screen recording is not supported in this browser. Attach an existing recording instead.");
        recorder = new MediaRecorder(stream, { mimeType: recorderType, videoBitsPerSecond: 1_000_000 });
        const chunks: Blob[] = []; let bytes = 0;
        const finish = () => { if (recorder?.state === "recording") recorder.stop(); };
        stopRecording.current = finish;
        recorder.ondataavailable = event => {
          if (discarded || !mounted.current || version !== generation.current) return;
          bytes += event.data.size;
          if (bytes > MAX_FILE) { discarded = true; setError("Recording exceeded 10 MB. Try a shorter recording."); finish(); return; }
          if (event.data.size) chunks.push(event.data);
        };
        recorder.onerror = () => { if (discarded || version !== generation.current) return; discarded = true; if (mounted.current) setError("Recording failed. Try again or attach an existing file."); finish(); release(); };
        recorder.onstop = () => {
          if (finished) return; finished = true; release(false);
          if (discarded || !mounted.current || version !== generation.current) { release(); return; }
          const type = recorder!.mimeType.split(";")[0]!;
          busy(true);
          void prepare(new File(chunks, type === "video/mp4" ? "screen-recording.mp4" : "screen-recording.webm", { type }))
            .then(file => { if (mounted.current && version === generation.current && !discarded) append([file]); })
            .catch(cause => { if (mounted.current && !discarded && version === generation.current) setError(cause instanceof Error ? cause.message : "Recording failed."); })
            .finally(() => release());
        };
        stream.getVideoTracks().forEach(track => track.addEventListener("ended", finish, { once: true }));
        recorder.start(250); setRecording(true);
        const started = performance.now();
        timer = setInterval(() => { const elapsed = Math.floor((performance.now() - started) / 1000); setSeconds(elapsed); if (elapsed >= 60) finish(); }, 250);
      }
    } catch (cause) {
      release();
      if (!discarded && mounted.current && version === generation.current) setError(cause instanceof DOMException && cause.name === "NotAllowedError" ? "Capture was cancelled or not permitted. You can attach an existing file." : cause instanceof Error ? cause.message : "Capture is unavailable. Attach an existing file.");
    }
  }
  return <section className="feedback-media" aria-label="Optional context">
    <div className="feedback-media-actions">
      <input ref={input} type="file" accept={ACCEPT} multiple hidden aria-label="Choose feedback attachments" onChange={event => { const selected = [...(event.target.files ?? [])]; event.target.value = ""; void select(selected); }} />
      {captureSupported && <button type="button" disabled={locked || working || files.length >= 3} onClick={() => void capture("image")}>Screenshot this screen</button>}
      {captureSupported && recorderType && <button type="button" disabled={locked || working || files.length >= 3} onClick={() => void capture("video")}>Record this screen</button>}
      <button type="button" disabled={locked || working || files.length >= 3} onClick={() => input.current?.click()}>Attach existing files</button>
    </div>
    {captureSupported && <p className="feedback-corner-hint">Capture what you’re seeing in Orca. Choose this Orca tab if your browser asks. The composer gets out of the way, then returns for your review. Recording has no audio and stops after 60 seconds.</p>}
    <p className="feedback-corner-hint">Optional images or videos. Up to 3 files, 10 MB each, 20 MB total. Review for private mail, passwords and unrelated content before sending. Selected videos retain their audio and metadata.</p>
    {!captureSupported && <p className="feedback-corner-hint">Screen capture isn’t available here. Attach a screenshot or recording made with your device.</p>}
    {working && !captureMode && <p role="status">Preparing attachment…</p>}
    {captureMode && <CaptureControls hidden={snapshotting}>
      <span role="status">{recording ? `● Recording Orca · ${seconds}s / 60s · no audio` : "Preparing screen capture…"}</span>
      {recording && <button type="button" aria-keyshortcuts="Control+Shift+X Meta+Shift+X" onClick={() => stopRecording.current()}>Stop recording</button>}
      <button type="button" onClick={() => cancel.current()}>Cancel {recording ? "recording" : "capture"}</button>
    </CaptureControls>}
    {files.map(file => <figure key={file.id} className="feedback-media-preview">
      {file.mimeType.startsWith("image/") ? <img src={file.dataUrl} alt={`Preview of ${file.name}`} /> : <video src={file.dataUrl} controls preload="metadata" playsInline onError={() => { setUnplayable(current => current.includes(file.id) ? current : [...current, file.id]); if (!locked) onReviewed(false); setError("This browser cannot preview this video. Remove it and choose a supported recording."); }} />}
      <figcaption>{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</figcaption>
      <button type="button" disabled={locked || working} aria-label={`Remove ${file.name}`} onClick={() => { onChange(files.filter(item => item.id !== file.id)); onReviewed(false); }}>Remove</button>
    </figure>)}
    {files.length > 0 && <label className="feedback-media-review"><input type="checkbox" checked={reviewed} disabled={locked || working || files.some(file => unplayable.includes(file.id))} onChange={event => onReviewed(event.target.checked)} />I reviewed these attachments and want to share them in my Linear ticket.</label>}
    {error && <p role="alert" className="feedback-corner-error">{error}</p>}
  </section>;
}
