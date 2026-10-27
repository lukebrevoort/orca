import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { MailAttachment, MailProvider } from "@orca/shared";
import "./attachment-list.css";
import { TopLayer } from "./top-layer";

type Family = "pdf" | "image" | "spreadsheet" | "document" | "presentation" | "archive" | "audio" | "video" | "text" | "file";
export function describeAttachmentType(mimeType: unknown, filename: string): { family: Family; label: string } {
  const mime = typeof mimeType === "string" ? mimeType.toLowerCase().split(";")[0]!.trim() : "";
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (mime === "text/calendar" || ext === "ics") return { family: "text", label: "Calendar invite" };
  const types: [Family, string, boolean][] = [
    ["pdf", "PDF", mime === "application/pdf" || ext === "pdf"],
    ["image", "Image", mime.startsWith("image/") || /^(png|jpe?g|gif|webp|svg|heic|avif|bmp|tiff?)$/.test(ext)],
    ["spreadsheet", "Spreadsheet", /spreadsheet|excel|csv/.test(mime) || /^(xlsx?|ods|csv)$/.test(ext)],
    ["document", "Document", /word|opendocument.text|rtf/.test(mime) || /^(docx?|odt|rtf)$/.test(ext)],
    ["presentation", "Presentation", /presentation|powerpoint/.test(mime) || /^(pptx?|odp|key)$/.test(ext)],
    ["archive", "Archive", /zip|compressed|x-tar|gzip|x-7z|x-rar/.test(mime) || /^(zip|tar|gz|7z|rar|bz2)$/.test(ext)],
    ["audio", "Audio", mime.startsWith("audio/") || /^(mp3|wav|m4a|ogg|flac|aac)$/.test(ext)],
    ["video", "Video", mime.startsWith("video/") || /^(mp4|mov|webm|avi|mkv)$/.test(ext)],
    ["text", "Text", mime.startsWith("text/") || /json|javascript|xml/.test(mime) || /^(txt|md|js|ts|tsx|jsx|py|json|html|css|xml|log)$/.test(ext)],
  ];
  const match = types.find((type) => type[2]);
  return match ? { family: match[0], label: match[1] } : { family: "file", label: "File" };
}

function filenameExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot) : "";
}

export function truncateAttachmentFilename(filename: string): string {
  if (filename.length <= 60) return filename;
  const extension = filenameExtension(filename).slice(-20);
  const tailLength = Math.max(extension.length, 15);
  return `${filename.slice(0, 59 - tailLength)}…${filename.slice(-tailLength)}`;
}

export function sanitizeDownloadFilename(filename: string): string {
  const clean = filename.replace(/[/\\\u0000-\u001f\u007f]/g, "").trim().replace(/^\.+/, "").trim();
  if (!clean) return "attachment";
  if (clean.length <= 120) return clean;
  const extension = filenameExtension(clean).slice(-30);
  return clean.slice(0, 120 - extension.length) + extension;
}

const iconPaths: Record<Family, string> = {
  pdf: "M8 16v-5h2a1.5 1.5 0 0 1 0 3H8m6-3v5m-1-5h3",
  image: "M7 16l3-4 3 3 2-2 3 3M9 9h.01",
  spreadsheet: "M7 10h10M7 13h10M7 16h10M11 10v6",
  document: "M8 10h8M8 13h8M8 16h5",
  presentation: "M7 10h10v5H7zM12 15v3m-3 0 3-3 3 3",
  archive: "M11 7h2m-2 3h2m-2 3h2m-2 3h2",
  audio: "M10 15V9l6-1v6m-6 1a2 2 0 1 1-2-2h2m6 1a2 2 0 1 1-2-2h2",
  video: "M7 10h6v6H7zM13 12l4-2v6l-4-2",
  text: "M9 11l-2 2 2 2m6-4 2 2-2 2m-2-5-2 6",
  file: "M8 11h8M8 15h5",
};
export function AttachmentTypeIcon({ mimeType, filename }: Pick<MailAttachment, "mimeType" | "filename">) {
  const { family } = describeAttachmentType(mimeType, filename);
  return <svg aria-hidden="true" className="attachment-card-icon" data-attachment-family={family} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5" /><path d={iconPaths[family]} /></svg>;
}

function humanSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
const errors: Record<number, string> = {
  415: "Preview isn't available for this file. Download it instead.",
  413: "Too large to download here (over 25 MB). Open in Gmail.",
  409: "Reconnect Gmail to download.",
  404: "This file is no longer available.",
  501: "Downloads aren't supported for this account.",
};

type Props = { attachments: MailAttachment[]; accountId: string; provider: MailProvider; demoMode?: boolean; fetcher?: typeof fetch };
export function AttachmentList({ attachments, accountId, provider, demoMode = false, fetcher = fetch }: Props) {
  const previewOwner = useRef<string | null>(null);
  const acquirePreview = useCallback((id: string) => {
    if (previewOwner.current !== null) return false;
    previewOwner.current = id;
    return true;
  }, []);
  const releasePreview = useCallback((id: string) => {
    if (previewOwner.current === id) previewOwner.current = null;
  }, []);
  return (
    <>
      {provider === "outlook" && !demoMode ? (
        <p className="reader-attachments-note">Open this conversation in Outlook to download files.</p>
      ) : null}
      <ul className="attachment-card-list">
        {attachments.map((attachment) => (
          <AttachmentCard
            key={`${accountId}:${attachment.id}`}
            attachment={attachment}
            accountId={accountId}
            downloadable={provider === "gmail" || demoMode}
            demoMode={demoMode}
            fetcher={fetcher}
            acquirePreview={acquirePreview}
            releasePreview={releasePreview}
          />
        ))}
      </ul>
    </>
  );
}
function AttachmentCard({ attachment, accountId, downloadable, demoMode, fetcher, acquirePreview, releasePreview }: { acquirePreview: (id: string) => boolean; releasePreview: (id: string) => void; attachment: MailAttachment; accountId: string; downloadable: boolean; demoMode: boolean; fetcher: typeof fetch }) {
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const previewPending = useRef(false);
  const mounted = useRef(true);
  const labelId = useId();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; releasePreview(labelId); };
  }, [labelId, releasePreview]);
  useEffect(() => {
    if (!previewUrl) return;
    return () => { URL.revokeObjectURL(previewUrl); };
  }, [previewUrl]);
  function closePreview() {
    setPreviewUrl(null);
    releasePreview(labelId);
  }
  const previewMime = typeof attachment.mimeType === "string" ? attachment.mimeType.toLowerCase().split(";")[0]!.trim() : "";
  const canPreview = /^(image\/(png|jpeg|gif|webp))$/.test(previewMime) && attachment.size <= 10 * 1024 * 1024;
  async function preview() {
    if (previewLoading || previewPending.current || previewUrl) return;
    setError("");
    if (demoMode) { setError("Preview isn't available in the demo"); return; }
    if (!acquirePreview(labelId)) return;
    let opened = false;
    previewPending.current = true;
    setPreviewLoading(true);
    try {
      const response = await fetcher(`/v1/attachments/${encodeURIComponent(attachment.id)}?${new URLSearchParams({ accountId, disposition: "inline" })}`, { credentials: "include" });
      if (!mounted.current) return;
      if (!response.ok) { setError(errors[response.status] ?? "Preview failed. Try again."); return; }
      const blob = await response.blob();
      if (!mounted.current) return;
      if (!blob.size || blob.size > 10 * 1024 * 1024 || !/^image\/(png|jpeg|gif|webp)$/.test(blob.type)) {
        setError(errors[415]!); return;
      }
      setPreviewUrl(URL.createObjectURL(blob));
      opened = true;
    } catch { if (mounted.current) setError("Preview failed. Try again."); }
    finally { if (!opened) releasePreview(labelId); previewPending.current = false; if (mounted.current) setPreviewLoading(false); }
  }
  const tooLarge = attachment.size > 25 * 1024 * 1024;
  const visibleFilename = truncateAttachmentFilename(attachment.filename);
  async function download() {
    if (loading || tooLarge) return;
    setError("");
    if (demoMode) { setError("Downloads aren't available in the demo."); return; }
    setLoading(true);
    try {
      const response = await fetcher(`/v1/attachments/${encodeURIComponent(attachment.id)}?${new URLSearchParams({ accountId })}`, { credentials: "include" });
      if (!response.ok) { setError(errors[response.status] ?? "Download failed. Try again."); return; }
      const blob = await response.blob();
      if (blob.size === 0) { setError("Download failed. Try again."); return; }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      try {
        link.href = url;
        link.download = sanitizeDownloadFilename(attachment.filename);
        document.body.append(link);
        link.click();
      } finally {
        link.remove();
        // Let the browser begin consuming the blob before releasing its URL.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch { setError("Download failed. Try again."); }
    finally { setLoading(false); }
  }
  return <li className="attachment-card" tabIndex={0}>
    <AttachmentTypeIcon {...attachment} />
    <div className="attachment-card-meta">
      <strong className="attachment-card-filename" title={attachment.filename}>{visibleFilename}</strong>
      <small>{describeAttachmentType(attachment.mimeType, attachment.filename).label} · {humanSize(attachment.size)}</small>
    </div>
    <div className="attachment-card-actions">
    {downloadable && canPreview ? <button ref={previewButton} className="attachment-card-download" type="button" disabled={previewLoading} aria-label={`Preview ${visibleFilename}`} onClick={() => void preview()}>Preview</button> : null}
    {downloadable ? (
      <button
        className="attachment-card-download"
        type="button"
        aria-label={`Download ${visibleFilename}`}
        aria-busy={loading}
        disabled={loading || tooLarge}
        onClick={() => void download()}
      >
        {loading ? "Downloading…" : "Download"}
      </button>
    ) : null}
    </div>
    {previewUrl ? <TopLayer backdrop={false} layerClassName="attachment-preview-backdrop" className="attachment-preview-dialog" ariaLabelledBy={labelId} initialFocusRef={closeButton} returnFocusRef={previewButton} onClose={closePreview}>
      <strong id={labelId}>{attachment.filename}</strong>
      <button ref={closeButton} className="attachment-card-download" type="button" onClick={closePreview}>Close preview</button>
      <img src={previewUrl} alt={attachment.filename} />
    </TopLayer> : null}
    <p className="attachment-card-status" role="status" aria-live="polite">{tooLarge ? errors[413] : error}</p>
  </li>;
}
