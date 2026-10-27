import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { AttachmentList, AttachmentTypeIcon, describeAttachmentType, truncateAttachmentFilename, sanitizeDownloadFilename } from "./attachment-list";
import { ComposeWorkspace, createEmptyComposeDraft, type ComposeDraftController } from "./compose-workspace";
import { demoAttachments } from "./demo-data";

const attachment = { id: "file /1", filename: "A very long board review document.pdf", mimeType: "application/pdf", size: 2516582 };
const props = { attachments: [attachment], accountId: "account &1", provider: "gmail" as const };
const names = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent"] as const;
const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let browser: Window;
let root: Root;
let host: HTMLDivElement;
let restoreAnchorClick: (() => void) | undefined;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
beforeEach(() => {
  browser = new Window({ url: "http://localhost" });
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: browser[name] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  restoreAnchorClick?.();
  restoreAnchorClick = undefined;
  browser.close();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  for (const name of names) { const original = originals.get(name); if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); }
  URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
});
async function render(extra: Partial<ComponentProps<typeof AttachmentList>> = {}) { await act(async () => root.render(<AttachmentList {...props} {...extra} />)); }
async function click() { await act(async () => host.querySelector("button")!.click()); }

describe("attachment types", () => {
  test.each([
    ["application/pdf", "x", "pdf", "PDF"], ["image/jpeg", "x", "image", "Image"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x", "spreadsheet", "Spreadsheet"],
    ["application/msword", "x", "document", "Document"], ["application/vnd.ms-powerpoint", "x", "presentation", "Presentation"],
    ["application/zip", "x", "archive", "Archive"], ["audio/mpeg", "x", "audio", "Audio"], ["video/quicktime", "x", "video", "Video"],
    ["text/plain", "x", "text", "Text"], ["text/calendar; charset=utf-8", "x", "text", "Calendar invite"],
    ["application/octet-stream", "BUDGET.XLSX", "spreadsheet", "Spreadsheet"], ["", "notes.docx", "document", "Document"],
    ["", "archive.7z", "archive", "Archive"], ["", "code.ts", "text", "Text"], ["unknown/type", "unknown.xyz", "file", "File"],
  ])("%s %s maps to %s", (mime, filename, family, label) => {
    expect(family).toBe(describeAttachmentType(mime, filename).family);
    expect(describeAttachmentType(mime, filename).label).toBe(label);
    expect(renderToStaticMarkup(<AttachmentTypeIcon mimeType={mime} filename={filename} />)).toContain(`data-attachment-family="${family}"`);
  });
});
test("friendly metadata, full filename title and keyboard focus", async () => {
  await render();
  expect(host.textContent).toContain("PDF · 2.4 MB"); expect(host.textContent).not.toContain("application/pdf");
  expect(host.querySelector(".attachment-card-filename")?.getAttribute("title")).toBe(attachment.filename);
  const card = host.querySelector<HTMLElement>(".attachment-card")!; card.focus(); expect(document.activeElement).toBe(card);
  const button = host.querySelector("button")!; button.focus(); expect(document.activeElement).toBe(button);
});
test("downloads the authenticated blob with the original filename and releases the URL", async () => {
  const fetcher = mock(async () => new Response("file content"));
  const create = mock(() => "blob:test"); const revoke = mock(() => {});
  URL.createObjectURL = create; URL.revokeObjectURL = revoke;
  let downloaded = ""; let href = "";
  const originalClick = browser.HTMLAnchorElement.prototype.click;
  restoreAnchorClick = () => { browser.HTMLAnchorElement.prototype.click = originalClick; };
  browser.HTMLAnchorElement.prototype.click = function () { downloaded = this.download; href = this.href; };
  const realSetTimeout = globalThis.setTimeout;
  let releaseUrl: (() => void) | undefined;
  globalThis.setTimeout = ((...[callback, delay, ...args]: Parameters<typeof globalThis.setTimeout>) => {
    if (delay === 1000) {
      releaseUrl = () => callback(...args);
      return realSetTimeout(() => {}, 0);
    }
    return realSetTimeout(callback, delay, ...args);
  }) as typeof globalThis.setTimeout;
  try {
    await render({ fetcher: fetcher as unknown as typeof fetch }); await click();
    expect(fetcher).toHaveBeenCalledWith("/v1/attachments/file%20%2F1?accountId=account+%261", { credentials: "include" });
    expect(create).toHaveBeenCalledTimes(1); expect(downloaded).toBe(attachment.filename); expect(href).toBe("blob:test");
    expect(document.querySelector("a[download]")).toBeNull();
    expect(releaseUrl).toBeDefined();
    expect(revoke).not.toHaveBeenCalled();
    releaseUrl!();
    expect(revoke).toHaveBeenCalledWith("blob:test");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
test.each([
  [413, "Too large to download here (over 25 MB). Open in Gmail."], [409, "Reconnect Gmail to download."],
  [404, "This file is no longer available."], [502, "Download failed. Try again."], [501, "Downloads aren't supported for this account."],
])("HTTP %s has a retryable inline state", async (status, copy) => {
  const fetcher = mock(async () => new Response(null, { status }));
  await render({ fetcher: fetcher as unknown as typeof fetch }); await click();
  expect(host.querySelector('[role="status"]')?.textContent).toBe(copy); expect(host.querySelector("button")?.disabled).toBe(false);
  await click(); expect(fetcher).toHaveBeenCalledTimes(2);
});
test("network errors stay retryable", async () => {
  await render({ fetcher: mock(async () => { throw new Error("offline"); }) as unknown as typeof fetch }); await click();
  expect(host.textContent).toContain("Download failed. Try again."); expect(host.querySelector("button")?.disabled).toBe(false);
});
test("loading disables the button until the response completes", async () => {
  let resolve!: (response: Response) => void;
  await render({ fetcher: (() => new Promise<Response>((done) => { resolve = done; })) as unknown as typeof fetch });
  await click(); expect(host.querySelector("button")?.disabled).toBe(true); expect(host.textContent).toContain("Downloading…");
  expect(host.querySelector("button")?.getAttribute("aria-busy")).toBe("true");
  await act(async () => resolve(new Response(null, { status: 404 }))); expect(host.querySelector("button")?.disabled).toBe(false);
});
test("Outlook has one message note and focusable cards without download buttons", async () => {
  await render({ provider: "outlook", attachments: [attachment, { ...attachment, id: "second" }] });
  expect(host.querySelectorAll(".reader-attachments-note")).toHaveLength(1); expect(host.textContent).toContain("Open this conversation in Outlook to download files.");
  expect(host.querySelector("button")).toBeNull(); expect(host.querySelectorAll('[tabindex="0"]')).toHaveLength(2);
});
test("demo downloads explain availability without a request", async () => {
  const fetcher = mock(async () => new Response()); await render({ demoMode: true, fetcher: fetcher as unknown as typeof fetch }); await click();
  expect(host.textContent).toContain("Downloads aren't available in the demo."); expect(fetcher).not.toHaveBeenCalled();
});
test("demo fixtures cover six types including a large file and long filename", () => {
  expect(demoAttachments).toHaveLength(6); expect(demoAttachments.some((file) => file.size > 25 * 1024 * 1024)).toBe(true);
  expect(demoAttachments.some((file) => file.filename.length > 70)).toBe(true);
});
test("compose chips use square bordered thumbnails and shared type icons", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const draft = createEmptyComposeDraft("account");
  draft.attachments = [
    { ...attachment, file: new File(["pdf"], attachment.filename), previewUrl: null },
    { id: "image", filename: "photo.jpg", mimeType: "image/jpeg", size: 1234, file: new File(["image"], "photo.jpg"), previewUrl: "blob:local-image" },
  ];
  const controller: ComposeDraftController = { draft, saveStatus: "saved", hasContent: true, updateDraft: () => {}, attachFiles: () => ({ accepted: [], rejected: [] }), removeAttachment: () => {}, discardDraft: () => {} };
  const html = renderToStaticMarkup(<ComposeWorkspace controller={controller} contacts={[]} />);
  expect(html).toContain('class="compose-attachment-chip-preview"');
  expect(html).toContain('src="blob:local-image"');
  expect(html).toContain('data-attachment-family="pdf"');
  expect(css).toMatch(/\.compose-attachment-chip-preview \{[^}]*border-radius: 6px;[^}]*height: 40px;[^}]*object-fit: cover;[^}]*width: 40px;/);
  expect(css).toContain('.compose-attachment-error { color: var(--orca-danger);');
});

// Hostile/broken-response coverage. Keep these cases separate from the original suite.
function captureHostileDownload() {
  const downloads: string[] = [];
  URL.createObjectURL = mock(() => "blob:hostile-test");
  URL.revokeObjectURL = mock(() => {});
  const originalClick = browser.HTMLAnchorElement.prototype.click;
  restoreAnchorClick = () => { browser.HTMLAnchorElement.prototype.click = originalClick; };
  browser.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  return downloads;
}

const hostileFilenames = [
  "../../etc/passwd",
  "<img src=x onerror=1>.pdf",
  "folder/subfolder\\report.pdf",
  "control\u0000\u0001\n\r\t.pdf",
  "a".repeat(300),
];

test("HTTP 401 shows a generic failure and never leaves download disabled", async () => {
  const fetcher = mock(async () => new Response("private auth details", { status: 401 }));
  await render({ fetcher: fetcher as unknown as typeof fetch });
  await click();
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Download failed. Try again.");
  expect(host.textContent).not.toContain("private auth details");
  expect(host.querySelector("button")?.disabled).toBe(false);
});

test("empty successful response reports failure without creating a browser download", async () => {
  const downloads = captureHostileDownload();
  await render({ fetcher: mock(async () => new Response(null)) as unknown as typeof fetch });
  await click();
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Download failed. Try again.");
  expect(host.querySelector("button")?.disabled).toBe(false);
  expect(downloads).toHaveLength(0);
});

test("rejected fetch never crashes or creates a browser download", async () => {
  const downloads = captureHostileDownload();
  await render({ fetcher: mock(async () => Promise.reject(new TypeError("connection reset"))) as unknown as typeof fetch });
  await click();
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Download failed. Try again.");
  expect(host.querySelector("button")?.disabled).toBe(false);
  expect(downloads).toHaveLength(0);
});

test.each(hostileFilenames)("hostile filename stays inert with no img script or onerror element: %s", async (filename) => {
  await render({ attachments: [{ ...attachment, filename }] });
  const card = host.querySelector(".attachment-card")!;
  expect(card.querySelector("img, script, [onerror]")).toBeNull();
  expect(card.querySelector(".attachment-card-filename")?.textContent).toBe(filename.length > 60 ? truncateAttachmentFilename(filename) : filename);
  expect(card.querySelector(".attachment-card-filename")?.getAttribute("title")).toBe(filename);
});

test.each(hostileFilenames)("browser download filename contains no path separators: %s", async (filename) => {
  const downloads = captureHostileDownload();
  await render({ attachments: [{ ...attachment, filename }], fetcher: mock(async () => new Response("bytes")) as unknown as typeof fetch });
  await click();
  expect(downloads).toHaveLength(1);
  expect(downloads[0]).not.toMatch(/[/\\]/);
});

test("truncated long filename exposes the full name only in its title attribute", async () => {
  const filename = "a".repeat(300);
  await render({ attachments: [{ ...attachment, filename }] });
  const label = host.querySelector(".attachment-card-filename")!;
  expect(label.getAttribute("title")).toBe(filename);
  expect(host.textContent).not.toContain(filename);
  expect(host.querySelector("button")?.getAttribute("aria-label")).not.toContain(filename);
});

test.each(["unknown/type", ""])("unknown or empty MIME %s renders the generic File label", async (mimeType) => {
  await render({ attachments: [{ ...attachment, filename: "opaque.unknown", mimeType }] });
  expect(host.querySelector("small")?.textContent).toBe("File · 2.4 MB");
  expect(host.querySelector('[data-attachment-family="file"]')).not.toBeNull();
});

test("missing MIME renders the generic File label without crashing", async () => {
  await render({ attachments: [{ ...attachment, filename: "opaque.unknown", mimeType: undefined as unknown as string }] });
  expect(host.querySelector("small")?.textContent).toBe("File · 2.4 MB");
});

test("size over 25 MB disables download up front without fetching", async () => {
  const fetcher = mock(async () => new Response("bytes"));
  await render({ attachments: [{ ...attachment, size: 26 * 1024 * 1024 }], fetcher: fetcher as unknown as typeof fetch });
  expect(host.querySelector("small")?.textContent).toBe("PDF · 26.0 MB");
  expect(host.querySelector("button")?.disabled).toBe(true);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Too large to download here (over 25 MB). Open in Gmail.");
  await click();
  expect(fetcher).not.toHaveBeenCalled();
});

test("server 413 for an attachment under 25 MB stays retryable", async () => {
  const fetcher = mock(async () => new Response(null, { status: 413 }));
  await render({ fetcher: fetcher as unknown as typeof fetch });
  expect(host.querySelector("small")?.textContent).toBe("PDF · 2.4 MB");
  expect(host.querySelector("button")?.disabled).toBe(false);
  await click();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Too large to download here (over 25 MB). Open in Gmail.");
  expect(host.querySelector("button")?.disabled).toBe(false);
});

test("successful retry clears the earlier failure message", async () => {
  const downloads = captureHostileDownload();
  let attempt = 0;
  const fetcher = mock(async () => ++attempt === 1 ? new Response(null, { status: 401 }) : new Response("file bytes"));
  await render({ fetcher: fetcher as unknown as typeof fetch });
  await click();
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Download failed. Try again.");
  await click();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(downloads).toEqual([attachment.filename]);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("");
  expect(host.querySelector("button")?.disabled).toBe(false);
});

test("Gmail attachments never show the Outlook download note", async () => {
  await render();
  expect(host.querySelector(".reader-attachments-note")).toBeNull();
  expect(host.textContent).not.toContain("Open this conversation in Outlook");
});

test("fetch only targets the encoded local attachment endpoint with included credentials", async () => {
  const id = "../file /?#&=+%\\雪";
  const accountId = "account /?&#=+%\\雪";
  const fetcher = mock(async () => new Response(null, { status: 404 }));
  await render({ attachments: [{ ...attachment, id }], accountId, fetcher: fetcher as unknown as typeof fetch });
  await click();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(
    "/v1/attachments/..%2Ffile%20%2F%3F%23%26%3D%2B%25%5C%E9%9B%AA?accountId=account+%2F%3F%26%23%3D%2B%25%5C%E9%9B%AA",
    { credentials: "include" },
  );
});

test.each([undefined, null, 42, {}])("non-string MIME falls back to extension or File: %s", (mimeType) => {
  expect(describeAttachmentType(mimeType, "report.pdf").label).toBe("PDF");
  expect(describeAttachmentType(mimeType, "opaque.unknown").label).toBe("File");
});

test("download filename removes controls separators leading dots and whitespace with an empty fallback", () => {
  expect(sanitizeDownloadFilename("  .../\\report\u0000\u001f\u007f.pdf  ")).toBe("report.pdf");
  expect(sanitizeDownloadFilename(" ../\\\u0000 ")).toBe("attachment");
  expect(sanitizeDownloadFilename("a".repeat(300) + ".pdf")).toBe("a".repeat(116) + ".pdf");
});

test("visible filename uses a middle ellipsis within 60 characters and keeps the extension", () => {
  const filename = "a".repeat(300) + ".pdf";
  const visible = truncateAttachmentFilename(filename);
  expect(visible.length).toBe(60);
  expect(visible).toContain("…");
  expect(visible.endsWith(".pdf")).toBe(true);
});
