import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { TopLayer } from "./top-layer";
import { deliveryResultSchema, messageDraftSchema, outboundRecipientSchema, type DeliveryResult, type InboxMessage, type MailContact, type MessageDraft, type OutboundContext } from "@orca/shared";

export type RecipientKind = "to" | "cc" | "bcc";
export type ComposeSaveStatus = "saved" | "saving" | "failed";
export type ComposeDeliveryStatus = "idle" | "sending" | "sent" | "error";

export type ComposeAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  file: File;
  previewUrl: string | null;
};

export type ComposeDraft = {
  id: string;
  accountId: string;
  revision: number | null;
  providerSyncStatus: MessageDraft["providerSyncStatus"] | null;
  providerSyncError: string | null;
  to: MailContact[];
  cc: MailContact[];
  bcc: MailContact[];
  subject: string;
  body: string;
  context: OutboundContext | null;
  attachments: ComposeAttachment[];
  updatedAt: string;
};

export type ComposeDraftFields = Pick<ComposeDraft, "to" | "cc" | "bcc" | "subject" | "body" | "context">;

export type ComposeDraftController = {
  draft: ComposeDraft;
  saveStatus: ComposeSaveStatus;
  saveMessage?: string;
  conflict?: ComposeDraftConflict | null;
  isHydrated?: boolean;
  hasContent: boolean;
  updateDraft: (update: Partial<ComposeDraftFields>) => void;
  attachFiles: (files: Iterable<File>) => ComposeAttachmentAcceptance;
  removeAttachment: (attachmentId: string) => void;
  discardDraft: () => Promise<boolean> | void;
  sendDraft?: (deliveryFields?: Partial<ComposeDraftFields>) => Promise<DeliveryResult>;
  retrySave?: () => void;
  resolveConflict?: (choice: "server" | "local") => Promise<void>;
};

export type ComposeDraftConflict = {
  server: MessageDraft;
  local: ComposeDraft;
};

export type ComposeAttachmentRejection = {
  filename: string;
  reason: string;
};

export type ComposeAttachmentAcceptance = {
  accepted: ComposeAttachment[];
  rejected: ComposeAttachmentRejection[];
};

export const MAX_COMPOSE_ATTACHMENTS = 25;
export const MAX_COMPOSE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const COMPOSE_AUTOSAVE_DELAY_MS = 420;
const PROVIDER_POLL_DELAY_MS = 500;

function draftStorageKey(accountId: string, scope = "new") {
  return `orca-compose-draft:${accountId}:${scope}`;
}

export function createEmptyComposeDraft(accountId: string): ComposeDraft {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `draft-${Date.now()}`,
    accountId,
    revision: null,
    providerSyncStatus: null,
    providerSyncError: null,
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    body: "",
    context: null,
    attachments: [],
    updatedAt: new Date().toISOString(),
  };
}

export function hasComposeContent(draft: ComposeDraft) {
  return draft.to.length + draft.cc.length + draft.bcc.length > 0
    || Boolean(draft.subject.trim())
    || Boolean(draft.body.trim())
    || draft.attachments.length > 0;
}

export function sanitizeAttachmentFilename(filename: string) {
  const base = filename.replace(/\\/g, "/").split("/").pop()?.trim() || "attachment";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").trim() || "attachment";
  return cleaned.slice(0, 255);
}

export function formatAttachmentSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function revokeComposeAttachment(attachment: ComposeAttachment) {
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}

export function revokeComposeAttachments(attachments: ComposeAttachment[]) {
  for (const attachment of attachments) revokeComposeAttachment(attachment);
}

export function acceptComposeFiles(
  existing: ComposeAttachment[],
  files: Iterable<File>,
  createObjectUrl: (file: File) => string = (file) => URL.createObjectURL(file),
): ComposeAttachmentAcceptance {
  const accepted: ComposeAttachment[] = [];
  const rejected: ComposeAttachmentRejection[] = [];
  let totalBytes = existing.reduce((sum, attachment) => sum + attachment.size, 0);
  let remainingSlots = MAX_COMPOSE_ATTACHMENTS - existing.length;

  for (const file of files) {
    const filename = sanitizeAttachmentFilename(file.name);
    if (remainingSlots <= 0) {
      rejected.push({ filename, reason: `You can attach up to ${MAX_COMPOSE_ATTACHMENTS} files.` });
      continue;
    }
    if (!Number.isFinite(file.size) || file.size <= 0) {
      rejected.push({ filename, reason: "Empty files can’t be attached." });
      continue;
    }
    if (file.size > MAX_COMPOSE_ATTACHMENT_BYTES) {
      rejected.push({ filename, reason: `Each file must be ${formatAttachmentSize(MAX_COMPOSE_ATTACHMENT_BYTES)} or smaller.` });
      continue;
    }
    if (totalBytes + file.size > MAX_COMPOSE_ATTACHMENT_BYTES) {
      rejected.push({ filename, reason: `Attachments together must stay under ${formatAttachmentSize(MAX_COMPOSE_ATTACHMENT_BYTES)}.` });
      continue;
    }
    const mimeType = file.type.trim() || "application/octet-stream";
    const previewUrl = mimeType.startsWith("image/") ? createObjectUrl(file) : null;
    accepted.push({
      id: globalThis.crypto?.randomUUID?.() ?? `attachment-${Date.now()}-${accepted.length}`,
      filename,
      mimeType,
      size: file.size,
      file,
      previewUrl,
    });
    totalBytes += file.size;
    remainingSlots -= 1;
  }

  return { accepted, rejected };
}

function persistableDraft(draft: ComposeDraft) {
  const { attachments: _attachments, ...rest } = draft;
  return rest;
}

function remoteContentSignature(draft: Pick<ComposeDraft, "to" | "cc" | "bcc" | "subject" | "body" | "context" | "attachments">) {
  return JSON.stringify({
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
    context: draft.context,
    attachments: draft.attachments.map(({ id, filename, mimeType, size }) => ({ id, filename, mimeType, size })),
  });
}

function draftMatchesScope(draft: MessageDraft, scope: string) {
  if (scope === "new") return draft.context === null;
  if (!draft.context) return false;
  return scope === `${draft.context.kind}:${draft.context.threadId}:${draft.context.messageId}`;
}

function fromMessageDraft(draft: MessageDraft): ComposeDraft {
  return {
    id: draft.id,
    accountId: draft.accountId,
    revision: draft.revision,
    providerSyncStatus: draft.providerSyncStatus,
    providerSyncError: draft.providerSyncError,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body.text,
    context: draft.context,
    attachments: [],
    updatedAt: draft.updatedAt,
  };
}

const messageDraftListSchema = {
  parse(value: unknown) {
    if (!Array.isArray(value)) throw new Error("Draft response was not a list");
    return value.map((item) => messageDraftSchema.parse(item));
  },
};

class DraftRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function requestDraft<T>(path: string, schema: { parse(value: unknown): T }, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const value = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = value as { error?: { code?: string; message?: string } };
    throw new DraftRequestError(response.status, error.error?.code ?? "request_failed", error.error?.message ?? "Draft request failed");
  }
  return schema.parse(value);
}

type DurableDraftContent = Omit<Pick<MessageDraft, "to" | "cc" | "bcc" | "subject" | "body" | "context" | "attachments">, "attachments"> & {
  attachments?: MessageDraft["attachments"];
};

export function buildDraftContent(
  draft: Pick<ComposeDraft, "to" | "cc" | "bcc" | "subject" | "body" | "context">,
  attachments: MessageDraft["attachments"],
  includeAttachments: boolean,
): DurableDraftContent {
  const content: DurableDraftContent = {
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: { text: draft.body, html: null },
    context: draft.context,
  };
  if (includeAttachments) content.attachments = attachments;
  return content;
}

export function mergeDraftAttachments(existing: MessageDraft["attachments"], additions: MessageDraft["attachments"]) {
  const merged = new Map(existing.map((attachment) => [attachment.id, attachment]));
  for (const attachment of additions) merged.set(attachment.id, attachment);
  return [...merged.values()];
}

type DurableDraftDeliveryOperations = {
  inspect(draftId: string): Promise<MessageDraft>;
  create(content: DurableDraftContent): Promise<MessageDraft>;
  update(draftId: string, revision: number, content: DurableDraftContent): Promise<MessageDraft>;
  send(draftId: string, revision: number, idempotencyKey: string): Promise<DeliveryResult>;
};

export async function deliverDurableDraft(
  input: {
    serverId: string | null;
    revision: number | null;
    content: DurableDraftContent;
    idempotencyKeyFor: (draftId: string) => string;
  },
  operations: DurableDraftDeliveryOperations,
): Promise<{ draft: MessageDraft; result: DeliveryResult }> {
  let saved: MessageDraft;
  if (input.serverId !== null && input.revision !== null) {
    const current = await operations.inspect(input.serverId);
    if (current.deliveryStatus !== "draft") {
      const result = current.deliveryStatus === "sent"
        ? sentDeliveryResult(current)
        : await operations.send(current.id, current.revision, input.idempotencyKeyFor(current.id));
      return { draft: current, result };
    }
    saved = await operations.update(current.id, current.revision, input.content);
  } else {
    saved = await operations.create(input.content);
  }

  const idempotencyKey = input.idempotencyKeyFor(saved.id);
  try {
    return {
      draft: saved,
      result: await operations.send(saved.id, saved.revision, idempotencyKey),
    };
  } catch (sendError) {
    try {
      const latest = await operations.inspect(saved.id);
      if (latest.deliveryStatus === "sent") return { draft: latest, result: sentDeliveryResult(latest) };
      if (latest.deliveryStatus !== "draft") {
        return {
          draft: latest,
          result: await operations.send(latest.id, latest.revision, idempotencyKey),
        };
      }
    } catch {
      // Preserve the original ambiguous send failure. A later retry inspects
      // the durable draft before updating and reuses the same key.
    }
    throw sendError;
  }
}

function sentDeliveryResult(draft: MessageDraft): DeliveryResult {
  return {
    draftId: draft.id,
    status: "sent",
    providerMessageId: draft.providerMessageId,
    providerThreadId: draft.providerThreadId,
    error: null,
  };
}

export function isValidEmail(value: string) {
  return outboundRecipientSchema.safeParse({ name: null, email: value }).success;
}

export function parseRecipientText(value: string): MailContact[] {
  return parseRecipientInput(value).contacts;
}

export function parseRecipientInput(value: string): { contacts: MailContact[]; invalid: string[] } {
  const seen = new Set<string>();
  const contacts: MailContact[] = [];
  const invalid: string[] = [];
  const tokens = value
    .split(/[\n,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const match = token.match(/^(.*?)\s*<([^<>]+)>$/);
    const candidate = match
      ? { name: match[1]!.trim().replace(/^['"]|['"]$/g, "") || null, email: match[2]!.trim().toLowerCase() }
      : { name: null, email: token.toLowerCase() };
    const parsed = outboundRecipientSchema.safeParse(candidate);
    if (!parsed.success) {
      invalid.push(token);
      continue;
    }
    const contact = parsed.data;
    if (!seen.has(contact.email)) {
      contacts.push(contact);
      seen.add(contact.email);
    }
  }

  return { contacts, invalid };
}

export function collectComposeContacts(messages: InboxMessage[], accountEmail: string) {
  const contacts = new Map<string, MailContact>();
  for (const message of messages) {
    const email = message.from.email.trim().toLowerCase();
    if (!email || email === accountEmail.trim().toLowerCase()) continue;
    const existing = contacts.get(email);
    if (!existing || (!existing.name && message.from.name)) contacts.set(email, { ...message.from, email });
  }
  return [...contacts.values()].sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
}

export function readComposeDraft(accountId: string, storage?: Pick<Storage, "getItem">, scope = "new"): ComposeDraft {
  const fallback = createEmptyComposeDraft(accountId);
  if (!storage) return fallback;
  try {
    const parsed = JSON.parse(storage.getItem(draftStorageKey(accountId, scope)) ?? "null") as Partial<ComposeDraft> | null;
    if (!parsed || parsed.accountId !== accountId || typeof parsed.id !== "string") return fallback;
    return {
      ...fallback,
      ...parsed,
      to: Array.isArray(parsed.to) ? parsed.to.filter((contact) => isValidEmail(contact.email)) : [],
      cc: Array.isArray(parsed.cc) ? parsed.cc.filter((contact) => isValidEmail(contact.email)) : [],
      bcc: Array.isArray(parsed.bcc) ? parsed.bcc.filter((contact) => isValidEmail(contact.email)) : [],
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      body: typeof parsed.body === "string" ? parsed.body : "",
      // Attachment bytes are kept in memory only — never round-trip through localStorage.
      attachments: [],
    };
  } catch {
    return fallback;
  }
}

export function useComposeDraft(accountId: string, scope = "new", demoMode?: boolean, demoDraft?: MessageDraft, availableDrafts?: MessageDraft[] | null): ComposeDraftController {
  const scopeKey = `${accountId}:${scope}`;
  const requestedDraftId = scope.startsWith("draft:") ? scope.slice("draft:".length) : null;
  const [draft, setDraft] = useState(() => readComposeDraft(accountId, typeof window === "undefined" ? undefined : window.localStorage, scope));
  const [saveStatus, setSaveStatus] = useState<ComposeSaveStatus>("saved");
  const [saveMessage, setSaveMessage] = useState("Not saved yet");
  const [conflict, setConflict] = useState<ComposeDraftConflict | null>(null);
  const [hydratedScope, setHydratedScope] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const storageScopeRef = useRef(scopeKey);
  const persistedDraftRef = useRef(JSON.stringify(persistableDraft(draft)));
  const pendingDraftRef = useRef<{ key: string; serialized: string } | null>(null);
  const attachmentsRef = useRef(draft.attachments);
  const serverIdRef = useRef(draft.revision === null ? null : draft.id);
  const serverRevisionRef = useRef(draft.revision);
  const lastRemoteSignatureRef = useRef<string | null>(null);
  const saveSequenceRef = useRef<Promise<void>>(Promise.resolve());
  const saveScopeRef = useRef(scopeKey);
  const attachmentsDirtyRef = useRef(draft.attachments.length > 0);
  const serverAttachmentsRef = useRef<MessageDraft["attachments"]>([]);
  const processedRetryTokenRef = useRef(0);
  const pollTimerRef = useRef<number | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const sendingRef = useRef(false);
  const sendIdempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    attachmentsRef.current = draft.attachments;
  }, [draft.attachments]);

  useEffect(() => () => {
    revokeComposeAttachments(attachmentsRef.current);
    if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
  }, []);

  const flushPendingDraft = useCallback(() => {
    const pending = pendingDraftRef.current;
    if (!pending || typeof window === "undefined") return true;
    try {
      window.localStorage.setItem(pending.key, pending.serialized);
      persistedDraftRef.current = pending.serialized;
      pendingDraftRef.current = null;
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    if (storageScopeRef.current === scopeKey) return;
    flushPendingDraft();
    storageScopeRef.current = scopeKey;
    saveScopeRef.current = scopeKey;
    saveSequenceRef.current = Promise.resolve();
    attachmentsDirtyRef.current = false;
    serverAttachmentsRef.current = [];
    revokeComposeAttachments(attachmentsRef.current);
    const restored = readComposeDraft(accountId, typeof window === "undefined" ? undefined : window.localStorage, scope);
    persistedDraftRef.current = JSON.stringify(persistableDraft(restored));
    serverIdRef.current = restored.revision === null ? null : restored.id;
    serverRevisionRef.current = restored.revision;
    lastRemoteSignatureRef.current = null;
    setConflict(null);
    setHydratedScope(null);
    setDraft(restored);
    setSaveStatus("saved");
    setSaveMessage(hasComposeContent(restored) ? "Recovered from this device" : "Not saved yet");
  }, [accountId, flushPendingDraft, scope, scopeKey]);

  useEffect(() => {
    if (demoMode) {
      setHydratedScope(scopeKey);
      if (requestedDraftId && demoDraft?.id === requestedDraftId) {
        const restored = fromMessageDraft(demoDraft);
        setDraft(restored);
        setSaveMessage("Saved on this device");
        return;
      }
      if (hasComposeContent(draft)) {
        setSaveMessage("Saved on this device");
      }
      return;
    }
    if (availableDrafts === null) return;
    let cancelled = false;
    const loadDrafts = availableDrafts === undefined
      ? requestDraft("/v1/drafts", messageDraftListSchema)
      : Promise.resolve(availableDrafts);
    void loadDrafts.then((drafts) => {
      if (cancelled) return;
      const editableDrafts = drafts.filter((item) => item.deliveryStatus === "draft");
      const local = readComposeDraft(accountId, window.localStorage, scope);
      const sameDraft = local.revision === null ? null : editableDrafts.find((item) => item.id === local.id);
      const requestedDraft = requestedDraftId ? editableDrafts.find((item) => item.id === requestedDraftId) : null;
      const latest = requestedDraft ?? sameDraft ?? editableDrafts.find((item) => draftMatchesScope(item, scope)) ?? null;
      if (!hasComposeContent(local) && latest) {
        const restored = fromMessageDraft(latest);
        serverIdRef.current = latest.id;
        serverRevisionRef.current = latest.revision;
        attachmentsDirtyRef.current = false;
        serverAttachmentsRef.current = latest.attachments;
        lastRemoteSignatureRef.current = remoteContentSignature(restored);
        persistedDraftRef.current = JSON.stringify(persistableDraft(restored));
        window.localStorage.setItem(draftStorageKey(accountId, scope), persistedDraftRef.current);
        setDraft(restored);
        setSaveStatus(latest.providerSyncStatus === "failed" ? "failed" : latest.providerSyncStatus === "pending" ? "saving" : "saved");
        setSaveMessage(providerSaveMessage(latest));
      } else if (hasComposeContent(local) && latest) {
        const serverDraft = fromMessageDraft(latest);
        serverIdRef.current = latest.id;
        serverRevisionRef.current = latest.revision;
        attachmentsDirtyRef.current = false;
        serverAttachmentsRef.current = latest.attachments;
        lastRemoteSignatureRef.current = remoteContentSignature(serverDraft);
        if (remoteContentSignature(local) !== lastRemoteSignatureRef.current && (local.revision === null || latest.revision > local.revision)) {
          setConflict({ server: latest, local });
          setSaveStatus("failed");
          setSaveMessage("Another version was saved — choose which one to keep");
        } else {
          setDraft((current) => ({ ...current, id: latest.id, revision: latest.revision, providerSyncStatus: latest.providerSyncStatus, providerSyncError: latest.providerSyncError }));
          setSaveStatus(latest.providerSyncStatus === "failed" ? "failed" : latest.providerSyncStatus === "pending" ? "saving" : "saved");
          setSaveMessage(providerSaveMessage(latest));
        }
      } else if (hasComposeContent(local)) {
        setRetryToken((current) => current + 1);
      }
      setHydratedScope(scopeKey);
    }).catch(() => {
      if (cancelled) return;
      setHydratedScope(scopeKey);
      if (hasComposeContent(draft)) {
        setSaveStatus("failed");
        setSaveMessage("Saved on this device · Orca will retry when connected");
      }
    });
    return () => { cancelled = true; };
  }, [accountId, availableDrafts, demoDraft, demoMode, requestedDraftId, scope, scopeKey]);

  const pollProviderStatus = useCallback((draftId: string) => {
    if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = window.setTimeout(() => {
      void requestDraft(`/v1/drafts/${encodeURIComponent(draftId)}`, messageDraftSchema).then((latest) => {
        if (serverIdRef.current !== latest.id || serverRevisionRef.current !== latest.revision) return;
        setDraft((current) => ({ ...current, providerSyncStatus: latest.providerSyncStatus, providerSyncError: latest.providerSyncError }));
        setSaveStatus(latest.providerSyncStatus === "failed" ? "failed" : latest.providerSyncStatus === "pending" ? "saving" : "saved");
        setSaveMessage(providerSaveMessage(latest));
        if (latest.providerSyncStatus === "pending") pollProviderStatus(latest.id);
      }).catch(() => {
        setSaveStatus("failed");
        setSaveMessage("Saved on this device · provider status is unavailable");
      });
    }, PROVIDER_POLL_DELAY_MS);
  }, []);

  const persistRemote = useCallback(async (snapshot: ComposeDraft, force = false, expectedScopeKey = scopeKey) => {
    if (storageScopeRef.current !== expectedScopeKey || saveScopeRef.current !== expectedScopeKey) return;
    if (!hasComposeContent(snapshot) || conflict) return;
    const signature = remoteContentSignature(snapshot);
    if (!force && signature === lastRemoteSignatureRef.current && serverIdRef.current) return;
    setSaveStatus("saving");
    setSaveMessage("Saving to Orca…");
    const attachments = snapshot.attachments.map(({ id, filename, mimeType, size }) => ({ id, filename, mimeType, size, contentBase64: null }));
    const serverId = serverIdRef.current;
    const revision = serverRevisionRef.current;
    const content = buildDraftContent(snapshot, mergeDraftAttachments(serverAttachmentsRef.current, attachments), attachmentsDirtyRef.current || serverId === null);
    try {
      const saved = serverId !== null && revision !== null
        ? await requestDraft(`/v1/drafts/${encodeURIComponent(serverId)}`, messageDraftSchema, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ revision, ...content }),
          })
        : await requestDraft("/v1/drafts", messageDraftSchema, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(content),
          });
      if (storageScopeRef.current !== expectedScopeKey || serverIdRef.current !== serverId || serverRevisionRef.current !== revision) return;
      serverIdRef.current = saved.id;
      serverRevisionRef.current = saved.revision;
      serverAttachmentsRef.current = saved.attachments;
      lastRemoteSignatureRef.current = signature;
      setDraft((current) => ({ ...current, id: saved.id, revision: saved.revision, providerSyncStatus: saved.providerSyncStatus, providerSyncError: saved.providerSyncError }));
      setSaveStatus(saved.providerSyncStatus === "pending" ? "saving" : saved.providerSyncStatus === "failed" ? "failed" : "saved");
      setSaveMessage(providerSaveMessage(saved));
      if (saved.providerSyncStatus === "pending") pollProviderStatus(saved.id);
    } catch (error) {
      if (storageScopeRef.current !== expectedScopeKey) return;
      if (error instanceof DraftRequestError && error.code === "stale_draft" && serverId) {
        try {
          const server = await requestDraft(`/v1/drafts/${encodeURIComponent(serverId)}`, messageDraftSchema);
          if (storageScopeRef.current !== expectedScopeKey) return;
          setConflict({ server, local: snapshot });
          setSaveMessage("Another version was saved — choose which one to keep");
        } catch {
          setSaveMessage("Saved on this device · Orca will retry when connected");
        }
      } else {
        setSaveMessage("Saved on this device · Orca will retry when connected");
      }
      setSaveStatus("failed");
    }
  }, [conflict, pollProviderStatus, scopeKey]);

  useEffect(() => {
    if (hydratedScope !== scopeKey) return;
    if (sendingRef.current) return;
    const serialized = JSON.stringify(persistableDraft(draft));
    if (serialized === persistedDraftRef.current && retryToken === processedRetryTokenRef.current) return;
    const needsRemoteSave = !demoMode && hasComposeContent(draft) && (
      !serverIdRef.current
      || remoteContentSignature(draft) !== lastRemoteSignatureRef.current
      || retryToken !== processedRetryTokenRef.current
    );
    const forceRemoteSave = retryToken !== processedRetryTokenRef.current;
    pendingDraftRef.current = { key: draftStorageKey(accountId, scope), serialized };
    if (needsRemoteSave) {
      setSaveStatus("saving");
      setSaveMessage("Saving…");
    }
    const timer = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      processedRetryTokenRef.current = retryToken;
      const localSaved = flushPendingDraft();
      if (!localSaved) {
        setSaveStatus("failed");
        setSaveMessage("Couldn’t save on this device — keep this tab open");
        return;
      }
      if (hydratedScope === scopeKey && needsRemoteSave && !conflict) {
        saveSequenceRef.current = saveSequenceRef.current.then(() => persistRemote(draft, forceRemoteSave, scopeKey));
      } else if (demoMode && hasComposeContent(draft)) {
        setSaveStatus("saved");
        setSaveMessage("Saved on this device");
      } else if (!hasComposeContent(draft)) {
        setSaveStatus("saved");
        setSaveMessage("Not saved yet");
      }
    }, COMPOSE_AUTOSAVE_DELAY_MS);
    autosaveTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (autosaveTimerRef.current === timer) autosaveTimerRef.current = null;
      flushPendingDraft();
    };
  }, [accountId, conflict, demoMode, draft, flushPendingDraft, hydratedScope, persistRemote, retryToken, scope, scopeKey]);

  useEffect(() => {
    const retry = () => setRetryToken((current) => current + 1);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, []);

  const hasContent = hasComposeContent(draft);
  useEffect(() => {
    if (!draft.attachments.length) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [draft.attachments.length]);

  function updateDraft(update: Partial<ComposeDraftFields>) {
    setDraft((current) => ({ ...current, ...update, updatedAt: new Date().toISOString() }));
  }

  function attachFiles(files: Iterable<File>): ComposeAttachmentAcceptance {
    let acceptance: ComposeAttachmentAcceptance = { accepted: [], rejected: [] };
    setDraft((current) => {
      acceptance = acceptComposeFiles(current.attachments, files);
      if (!acceptance.accepted.length) return current;
      attachmentsDirtyRef.current = true;
      return { ...current, attachments: [...current.attachments, ...acceptance.accepted], updatedAt: new Date().toISOString() };
    });
    return acceptance;
  }

  function removeAttachment(attachmentId: string) {
    setDraft((current) => {
      const remaining = current.attachments.filter((attachment) => attachment.id !== attachmentId);
      if (remaining.length === current.attachments.length) return current;
      attachmentsDirtyRef.current = true;
      for (const attachment of current.attachments) if (attachment.id === attachmentId) revokeComposeAttachment(attachment);
      return { ...current, attachments: remaining, updatedAt: new Date().toISOString() };
    });
  }

  async function discardDraft() {
    try {
      if (serverIdRef.current) {
        await requestDraft(`/v1/drafts/${encodeURIComponent(serverIdRef.current)}`, { parse: () => null }, { method: "DELETE" });
      }
    } catch (error) {
      setSaveStatus("failed");
      setSaveMessage(error instanceof DraftRequestError ? error.message : "Couldn’t discard this draft. It is still safe.");
      return false;
    }
    const empty = createEmptyComposeDraft(accountId);
    pendingDraftRef.current = null;
    revokeComposeAttachments(attachmentsRef.current);
    window.localStorage.removeItem(draftStorageKey(accountId, scope));
    persistedDraftRef.current = JSON.stringify(persistableDraft(empty));
    serverIdRef.current = null;
    serverRevisionRef.current = null;
    lastRemoteSignatureRef.current = null;
    attachmentsDirtyRef.current = false;
    serverAttachmentsRef.current = [];
    setConflict(null);
    setDraft(empty);
    setSaveStatus("saved");
    setSaveMessage("Draft discarded");
    return true;
  }

  async function resolveConflict(choice: "server" | "local") {
    if (!conflict) return;
    if (choice === "server") {
      const restored = fromMessageDraft(conflict.server);
      serverIdRef.current = conflict.server.id;
      serverRevisionRef.current = conflict.server.revision;
      attachmentsDirtyRef.current = false;
      serverAttachmentsRef.current = conflict.server.attachments;
      lastRemoteSignatureRef.current = remoteContentSignature(restored);
      setDraft(restored);
      setConflict(null);
      setSaveStatus(conflict.server.providerSyncStatus === "failed" ? "failed" : "saved");
      setSaveMessage(providerSaveMessage(conflict.server));
      return;
    }
    const local = { ...conflict.local, id: crypto.randomUUID(), revision: null, providerSyncStatus: null, providerSyncError: null, updatedAt: new Date().toISOString() };
    serverIdRef.current = null;
    serverRevisionRef.current = null;
    lastRemoteSignatureRef.current = null;
    attachmentsDirtyRef.current = local.attachments.length > 0;
    serverAttachmentsRef.current = [];
    setConflict(null);
    setDraft(local);
    setRetryToken((current) => current + 1);
  }

  async function sendDraft(deliveryFields?: Partial<ComposeDraftFields>): Promise<DeliveryResult> {
    const deliveryDraft = deliveryFields
      ? { ...draft, ...deliveryFields, updatedAt: new Date().toISOString() }
      : draft;
    if (deliveryFields) setDraft(deliveryDraft);
    pendingDraftRef.current = {
      key: draftStorageKey(accountId, scope),
      serialized: JSON.stringify(persistableDraft(deliveryDraft)),
    };
    if (demoMode) {
      resetAfterSuccessfulSend();
      return { draftId: deliveryDraft.id, status: "sent", providerMessageId: `demo-${deliveryDraft.id}`, providerThreadId: deliveryDraft.context?.providerThreadId ?? null, error: null };
    }
    if (conflict) throw new Error("Resolve the saved draft conflict before sending.");
    sendingRef.current = true;
    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    if (pollTimerRef.current) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    flushPendingDraft();
    try {
      await saveSequenceRef.current;
      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      const content: DurableDraftContent = {
        to: deliveryDraft.to,
        cc: deliveryDraft.cc,
        bcc: deliveryDraft.bcc,
        subject: deliveryDraft.subject,
        body: { text: deliveryDraft.body, html: deliveryDraft.body.trim() ? markdownToEditorHtml(deliveryDraft.body) : null },
        context: deliveryDraft.context,
      };
      if (attachmentsDirtyRef.current || serverIdRef.current === null) {
        const localAttachments = await Promise.all(deliveryDraft.attachments.map(async ({ id, filename, mimeType, size, file }) => ({
          id,
          filename,
          mimeType,
          size,
          contentBase64: await fileToBase64(file),
        })));
        content.attachments = mergeDraftAttachments(serverAttachmentsRef.current, localAttachments);
      }
      const idempotencyKeyFor = (draftId: string) => {
        const storageKey = `orca-compose-send:${accountId}:${scope}:${draftId}`;
        const key = sendIdempotencyKeyRef.current
          ?? window.localStorage.getItem(storageKey)
          ?? crypto.randomUUID();
        sendIdempotencyKeyRef.current = key;
        window.localStorage.setItem(storageKey, key);
        return key;
      };
      const delivery = await deliverDurableDraft({
        serverId: serverIdRef.current,
        revision: serverRevisionRef.current,
        content,
        idempotencyKeyFor,
      }, {
        inspect: (draftId) => requestDraft(`/v1/drafts/${encodeURIComponent(draftId)}`, messageDraftSchema),
        create: async (nextContent) => {
          const saved = await requestDraft("/v1/drafts", messageDraftSchema, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(nextContent),
          });
          serverIdRef.current = saved.id;
          serverRevisionRef.current = saved.revision;
          serverAttachmentsRef.current = saved.attachments;
          return saved;
        },
        update: async (draftId, revision, nextContent) => {
          const saved = await requestDraft(`/v1/drafts/${encodeURIComponent(draftId)}`, messageDraftSchema, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ revision, ...nextContent }),
          });
          serverIdRef.current = saved.id;
          serverRevisionRef.current = saved.revision;
          serverAttachmentsRef.current = saved.attachments;
          return saved;
        },
        send: (draftId, revision, idempotencyKey) => requestDraft(`/v1/drafts/${encodeURIComponent(draftId)}/send`, deliveryResultSchema, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision, idempotencyKey }),
        }),
      });
      serverIdRef.current = delivery.draft.id;
      serverRevisionRef.current = delivery.draft.revision;
      serverAttachmentsRef.current = delivery.draft.attachments;
      const idempotencyStorageKey = `orca-compose-send:${accountId}:${scope}:${delivery.draft.id}`;
      const result = delivery.result;
      if (result.status === "sent") {
        resetAfterSuccessfulSend();
        window.localStorage.removeItem(idempotencyStorageKey);
      }
      return result;
    } finally {
      sendingRef.current = false;
    }
  }

  function resetAfterSuccessfulSend() {
    const empty = createEmptyComposeDraft(accountId);
    revokeComposeAttachments(attachmentsRef.current);
    pendingDraftRef.current = null;
    persistedDraftRef.current = JSON.stringify(persistableDraft(empty));
    window.localStorage.removeItem(draftStorageKey(accountId, scope));
    serverIdRef.current = null;
    serverRevisionRef.current = null;
    lastRemoteSignatureRef.current = null;
    attachmentsDirtyRef.current = false;
    serverAttachmentsRef.current = [];
    sendIdempotencyKeyRef.current = null;
    setConflict(null);
    setDraft(empty);
    setSaveStatus("saved");
    setSaveMessage("Not saved yet");
  }

  return {
    draft,
    saveStatus,
    saveMessage,
    conflict,
    isHydrated: hydratedScope === scopeKey,
    hasContent,
    updateDraft,
    attachFiles,
    removeAttachment,
    discardDraft,
    sendDraft,
    retrySave: () => setRetryToken((current) => current + 1),
    resolveConflict,
  };
}

function providerSaveMessage(draft: MessageDraft) {
  if (draft.providerSyncStatus === "pending") return "Saved to Orca · syncing with Gmail…";
  if (draft.providerSyncStatus === "failed") return `Saved to Orca · ${draft.providerSyncError ?? "Gmail retry needed"}`;
  if (draft.providerSyncStatus === "synced") return "Saved to Orca and Gmail";
  return "Saved to Orca";
}

const slashCommands = [
  { id: "heading", label: "Heading", hint: "A clear section break", block: "heading" },
  { id: "bullets", label: "Bulleted list", hint: "Turn thoughts into points", block: "bullets" },
  { id: "numbered", label: "Numbered list", hint: "Give ideas an order", block: "numbered" },
  { id: "quote", label: "Quote", hint: "Set a passage apart", block: "quote" },
  { id: "divider", label: "Divider", hint: "Create a quiet pause", block: "divider" },
] as const;

type SlashCommand = (typeof slashCommands)[number];

const composeIntros = [
  { kicker: "A note from you", title: "Write first. Send when it’s ready." },
  { kicker: "In your own words", title: "Make a little room for the thought." },
  { kicker: "A quiet place to begin", title: "Say the part that matters." },
] as const;

const recipientKinds: RecipientKind[] = ["to", "cc", "bcc"];
const recipientLabels: Record<RecipientKind, string> = { to: "To", cc: "Cc", bcc: "Bcc" };

function emptyRecipientState() {
  return { to: "", cc: "", bcc: "" } satisfies Record<RecipientKind, string>;
}

function recipientValidationMessage(invalid: string[]) {
  const visible = invalid.map((token) => `“${token}”`).join(", ");
  return `${visible} ${invalid.length === 1 ? "isn’t" : "aren’t"} complete. Choose a suggestion or enter a complete email address.`;
}

function mergeRecipients(existing: MailContact[], pending: MailContact[]) {
  const merged = [...existing];
  const seen = new Set(existing.map((recipient) => recipient.email.trim().toLowerCase()));
  for (const recipient of pending) {
    const email = recipient.email.trim().toLowerCase();
    if (!seen.has(email)) {
      merged.push({ ...recipient, email });
      seen.add(email);
    }
  }
  return merged;
}

export function ComposeWorkspace({
  controller,
  contacts,
  autoFocusTo = false,
  closing = false,
  variant = "panel",
  onExitZen,
  onClose,
  replyLabel,
  actionLabel = "Reply",
  canSend = false,
  onRequestSendAccess,
  onSent,
}: {
  controller: ComposeDraftController;
  contacts: MailContact[];
  autoFocusTo?: boolean;
  closing?: boolean;
  variant?: "panel" | "zen" | "reply";
  onExitZen?: (reason: "escape" | "button") => void;
  onClose?: () => void;
  replyLabel?: string;
  actionLabel?: "Reply" | "Reply all" | "Forward";
  canSend?: boolean;
  onRequestSendAccess?: () => void;
  onSent?: (result: DeliveryResult) => Promise<void> | void;
}) {
  const {
    draft,
    saveStatus,
    saveMessage = saveStatus === "saved" ? (draft.attachments.length ? "Text saved" : "Saved on this device") : saveStatus === "saving" ? "Saving…" : "Couldn’t save — keep this tab open",
    conflict = null,
    hasContent,
    updateDraft,
    attachFiles,
    removeAttachment,
    discardDraft,
    sendDraft = async () => { throw new Error("This draft is not ready to send."); },
    retrySave = () => {},
    resolveConflict = async () => {},
  } = controller;
  const [showCarbonCopy, setShowCarbonCopy] = useState(draft.cc.length + draft.bcc.length > 0);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [editReplyDetails, setEditReplyDetails] = useState(actionLabel === "Forward");
  const [deliveryStatus, setDeliveryStatus] = useState<ComposeDeliveryStatus>("idle");
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [deliveryValidationError, setDeliveryValidationError] = useState<string | null>(null);
  const [recipientQueries, setRecipientQueries] = useState<Record<RecipientKind, string>>(emptyRecipientState);
  const [recipientErrors, setRecipientErrors] = useState<Record<RecipientKind, string>>(emptyRecipientState);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageBodyRef = useRef<HTMLDivElement>(null);
  const recipientInputRefs = useRef<Record<RecipientKind, HTMLInputElement | null>>({ to: null, cc: null, bcc: null });
  const deliveryReasonId = useId();
  const contactsLabel = contacts.length === 1 ? "1 contact" : `${contacts.length} contacts`;
  const intro = composeIntros[hashText(draft.id) % composeIntros.length]!;
  const pendingRecipientKinds = recipientKinds.filter((kind) => recipientQueries[kind].trim());
  const pendingRecipientResults = new Map(pendingRecipientKinds.map((kind) => [kind, parseRecipientInput(recipientQueries[kind])]));
  const invalidPendingKinds = pendingRecipientKinds.filter((kind) => {
    const parsed = pendingRecipientResults.get(kind)!;
    return parsed.invalid.length > 0 || parsed.contacts.length === 0;
  });
  const hasPotentialTo = draft.to.length > 0 || (pendingRecipientResults.get("to")?.contacts.length ?? 0) > 0;
  const hasDeliverableMessage = Boolean(draft.body.trim()) || draft.attachments.length > 0;
  const deliveryReady = hasPotentialTo && invalidPendingKinds.length === 0 && hasDeliverableMessage;
  const deliveryReason = invalidPendingKinds.length > 0
    ? `Finish the visible ${invalidPendingKinds.map((kind) => recipientLabels[kind]).join("/")} address ${invalidPendingKinds.length === 1 ? "field" : "fields"}. Choose a suggestion or enter every complete email address.`
    : !hasPotentialTo
    ? "Add at least one valid recipient to prepare this message."
    : !hasDeliverableMessage
      ? variant === "reply"
        ? "Write a reply or add an attachment before sending. Attachment-only replies are supported when a file is attached."
        : "Write a message or add an attachment before sending. Attachment-only messages are supported when a file is attached."
    : canSend
      ? pendingRecipientKinds.length
        ? "Every complete visible address will be added before Orca saves and delivers this message."
        : "Gmail has confirmed draft and send access. Orca will save the draft first, then deliver it once."
      : "This account is read-only. Enable Gmail compose access before Orca can create drafts or send mail.";

  async function closeOrDiscard() {
    if (!hasContent) {
      onClose?.();
      return;
    }
    if (window.confirm("Discard this draft from Orca and Gmail?")) {
      const discarded = await discardDraft();
      if (discarded !== false) onClose?.();
    }
  }

  function focusRecipient(kind: RecipientKind) {
    if (kind !== "to") setShowCarbonCopy(true);
    const input = recipientInputRefs.current[kind];
    if (input) input.focus();
    else window.requestAnimationFrame(() => recipientInputRefs.current[kind]?.focus());
  }

  function resolvePendingRecipients(): Partial<ComposeDraftFields> | null {
    const parsed = new Map<RecipientKind, ReturnType<typeof parseRecipientInput>>();
    const nextErrors = emptyRecipientState();
    let firstInvalid: RecipientKind | null = null;
    for (const kind of recipientKinds) {
      const query = recipientQueries[kind];
      if (!query.trim()) continue;
      const result = parseRecipientInput(query);
      parsed.set(kind, result);
      if (result.invalid.length > 0 || result.contacts.length === 0) {
        nextErrors[kind] = recipientValidationMessage(result.invalid.length ? result.invalid : [query.trim()]);
        firstInvalid ??= kind;
      }
    }
    if (firstInvalid) {
      setRecipientErrors(nextErrors);
      setDeliveryValidationError("Every visible recipient stays in your draft. Check the highlighted address before sending.");
      focusRecipient(firstInvalid);
      return null;
    }

    const deliveryFields: Partial<ComposeDraftFields> = {};
    for (const kind of recipientKinds) {
      const result = parsed.get(kind);
      if (result) deliveryFields[kind] = mergeRecipients(draft[kind], result.contacts);
    }
    const deliveryTo = deliveryFields.to ?? draft.to;
    if (deliveryTo.length === 0) {
      nextErrors.to = "Add at least one valid recipient before sending.";
      setRecipientErrors(nextErrors);
      setDeliveryValidationError("Your draft is still here. Add a recipient before sending.");
      focusRecipient("to");
      return null;
    }

    setRecipientErrors(nextErrors);
    if (parsed.size > 0) {
      updateDraft(deliveryFields);
      setRecipientQueries(emptyRecipientState());
    }
    return deliveryFields;
  }

  async function attemptDelivery() {
    const deliveryFields = resolvePendingRecipients();
    if (!deliveryFields) return;
    if (!hasDeliverableMessage) {
      setDeliveryValidationError(variant === "reply"
        ? "Write a reply or add an attachment before sending. Your reply is still here."
        : "Write a message or add an attachment before sending. Your draft is still here.");
      messageBodyRef.current?.focus();
      return;
    }
    setDeliveryValidationError(null);
    if (!canSend) {
      onRequestSendAccess?.();
      return;
    }
    await sendCurrentDraft(deliveryFields);
  }

  async function sendCurrentDraft(deliveryFields: Partial<ComposeDraftFields>) {
    setDeliveryStatus("sending");
    setDeliveryError(null);
    try {
      const result = await sendDraft(deliveryFields);
      if (result.status !== "sent") throw new Error(result.error?.message ?? "Gmail did not confirm delivery. Check Drafts before retrying.");
      setDeliveryStatus("sent");
      try {
        await onSent?.(result);
      } catch {
        setDeliveryError("Sent, but Orca could not refresh the conversation. Refresh to see the delivered message.");
      }
    } catch (error) {
      setDeliveryStatus("error");
      setDeliveryError(error instanceof Error ? error.message : "Orca could not confirm delivery.");
    }
  }

  function applyFiles(fileList: Iterable<File>) {
    const { accepted, rejected } = attachFiles(fileList);
    if (accepted.length || rejected.length) {
      setAttachmentError(rejected.length ? rejected.map((item) => `${item.filename}: ${item.reason}`).join(" ") : null);
      if (accepted.length) setDeliveryValidationError(null);
    }
  }

  function onRemoveAttachment(attachmentId: string) {
    removeAttachment(attachmentId);
    setAttachmentError(null);
  }

  function hasFilePayload(event: DragEvent) {
    return [...(event.dataTransfer?.types ?? [])].includes("Files");
  }

  function onDragOver(event: DragEvent<HTMLElement>) {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDraggingFiles(true);
  }

  function onDragLeave(event: DragEvent<HTMLElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDraggingFiles(false);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    setDraggingFiles(false);
    const files = [...(event.dataTransfer.files ?? [])];
    if (files.length) applyFiles(files);
  }

  const dropHandlers = { onDragLeave, onDragOver, onDrop };
  const workspaceClass = `compose-workspace${draggingFiles ? " compose-workspace-drop" : ""}`;

  const editor = (
    <>
      {variant !== "reply" || editReplyDetails ? <div className="compose-addressing">
        <RecipientField autoFocus={autoFocusTo && variant === "panel"} contacts={contacts} error={recipientErrors.to} inputRef={(input) => { recipientInputRefs.current.to = input; }} kind="to" label="To" onChange={(to) => updateDraft({ to })} onErrorChange={(error) => setRecipientErrors((current) => ({ ...current, to: error }))} onQueryChange={(query) => { setRecipientQueries((current) => ({ ...current, to: query })); setDeliveryValidationError(null); }} query={recipientQueries.to} recipients={draft.to} />
        {showCarbonCopy ? (
          <>
            <RecipientField contacts={contacts} error={recipientErrors.cc} inputRef={(input) => { recipientInputRefs.current.cc = input; }} kind="cc" label="Cc" onChange={(cc) => updateDraft({ cc })} onErrorChange={(error) => setRecipientErrors((current) => ({ ...current, cc: error }))} onQueryChange={(query) => { setRecipientQueries((current) => ({ ...current, cc: query })); setDeliveryValidationError(null); }} query={recipientQueries.cc} recipients={draft.cc} />
            <RecipientField contacts={contacts} error={recipientErrors.bcc} inputRef={(input) => { recipientInputRefs.current.bcc = input; }} kind="bcc" label="Bcc" onChange={(bcc) => updateDraft({ bcc })} onErrorChange={(error) => setRecipientErrors((current) => ({ ...current, bcc: error }))} onQueryChange={(query) => { setRecipientQueries((current) => ({ ...current, bcc: query })); setDeliveryValidationError(null); }} query={recipientQueries.bcc} recipients={draft.bcc} />
          </>
        ) : null}
        <button aria-expanded={showCarbonCopy} className="compose-carbon-toggle" onClick={() => setShowCarbonCopy((shown) => !shown)} type="button">
          {showCarbonCopy ? "Hide Cc and Bcc" : "Add Cc or Bcc"}
        </button>
      </div> : <div className="compose-reply-context"><span>{actionLabel === "Reply all" ? "Replying to everyone" : "Replying to"}</span><strong>{replyLabel ?? draft.to.map((recipient) => recipient.name ?? recipient.email).join(", ")}</strong><span>{draft.subject}</span><button onClick={() => setEditReplyDetails(true)} type="button">Edit recipients</button></div>}

      {variant !== "reply" || editReplyDetails ? <label className="compose-subject-field">
        <span className="compose-subject-label">Sub</span>
        <input autoComplete="off" name="subject" onChange={(event) => updateDraft({ subject: event.target.value })} placeholder="Give this note a subject…" type="text" value={draft.subject} />
      </label> : null}

      <RenderedBlockEditor
        attachments={draft.attachments}
        autoFocus={variant === "zen" || variant === "reply"}
        body={draft.body}
        canAttach={draft.attachments.length < MAX_COMPOSE_ATTACHMENTS}
        describedBy={deliveryReasonId}
        focusRef={messageBodyRef}
        invalid={!hasDeliverableMessage && Boolean(deliveryValidationError)}
        onAttachClick={() => fileInputRef.current?.click()}
        onChange={(body) => { updateDraft({ body }); if (body.trim()) setDeliveryValidationError(null); }}
        onRemoveAttachment={onRemoveAttachment}
        placeholder={variant === "zen" ? "Say what you mean." : variant === "reply" ? actionLabel === "Forward" ? "Add a note above the forwarded message…" : "Write a reply…" : "Start with the human part…"}
      />
      {attachmentError ? <p className="compose-attachment-error" role="alert">{attachmentError}</p> : null}
      <input
        accept="*/*"
        aria-hidden="true"
        className="sr-only"
        multiple
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length) applyFiles(files);
        }}
        ref={fileInputRef}
        tabIndex={-1}
        type="file"
      />
    </>
  );

  if (variant === "zen") {
    return (
      <TopLayer ariaLabel="Zen writing mode" as="section" backdrop={false} className={`zen-canvas${closing ? " zen-canvas-closing" : ""}`} dismissible={!closing} initialFocusSelector={'[contenteditable="true"]'} onClose={() => onExitZen?.("escape")} surfaceProps={dropHandlers}>
        <header className="zen-header compose-zen-header">
          <button className="zen-back" onClick={() => onExitZen?.("button")} type="button"><span aria-hidden="true">←</span><span>Save &amp; close</span></button>
          <DraftStatus hasSessionAttachments={draft.attachments.length > 0} message={saveMessage} onRetry={retrySave} status={saveStatus} />
        </header>
        <div className="zen-stage">
          <div className={`zen-column ${workspaceClass} compose-workspace-zen`}>
            {editor}
            {conflict ? <DraftConflictNotice conflict={conflict} onResolve={resolveConflict} /> : null}
            <ComposeDeliveryBar canSend={canSend} controller={controller} deliveryError={deliveryValidationError ?? deliveryError} deliveryReady={deliveryReady} deliveryReason={deliveryReason} deliveryReasonId={deliveryReasonId} deliveryStatus={deliveryStatus} onDiscard={closeOrDiscard} onRequestSendAccess={onRequestSendAccess} onSend={attemptDelivery} />
            {draggingFiles ? <ComposeDropOverlay /> : null}
          </div>
        </div>
      </TopLayer>
    );
  }

  if (variant === "reply") {
    return (
      <section aria-label="Reply to conversation" className={`${workspaceClass} compose-workspace-reply`} {...dropHandlers}>
        {editor}
        {conflict ? <DraftConflictNotice conflict={conflict} onResolve={resolveConflict} /> : null}
        <ComposeDeliveryBar actionLabel={actionLabel} canSend={canSend} controller={controller} deliveryError={deliveryValidationError ?? deliveryError} deliveryReady={deliveryReady} deliveryReason={deliveryReason} deliveryReasonId={deliveryReasonId} deliveryStatus={deliveryStatus} onDiscard={closeOrDiscard} onRequestSendAccess={onRequestSendAccess} onSend={attemptDelivery} />
        {draggingFiles ? <ComposeDropOverlay /> : null}
      </section>
    );
  }

  return (
    <section aria-label="Compose message" className={`${workspaceClass} compose-workspace-panel`} {...dropHandlers}>
      <div className="compose-workspace-intro">
        <div><span className="compose-kicker">{intro.kicker}</span><h3>{intro.title}</h3></div>
        <span className="compose-contact-count">{contactsLabel}</span>
      </div>
      {editor}
      {conflict ? <DraftConflictNotice conflict={conflict} onResolve={resolveConflict} /> : null}
      <ComposeDeliveryBar canSend={canSend} controller={controller} deliveryError={deliveryValidationError ?? deliveryError} deliveryReady={deliveryReady} deliveryReason={deliveryReason} deliveryReasonId={deliveryReasonId} deliveryStatus={deliveryStatus} onDiscard={closeOrDiscard} onRequestSendAccess={onRequestSendAccess} onSend={attemptDelivery} />
      {draggingFiles ? <ComposeDropOverlay /> : null}
    </section>
  );
}

function RenderedBlockEditor({
  attachments,
  autoFocus,
  body,
  canAttach,
  describedBy,
  focusRef,
  invalid,
  onAttachClick,
  onChange,
  onRemoveAttachment,
  placeholder,
}: {
  attachments: ComposeAttachment[];
  autoFocus: boolean;
  body: string;
  canAttach: boolean;
  describedBy?: string;
  focusRef: RefObject<HTMLDivElement | null>;
  invalid: boolean;
  onAttachClick: () => void;
  onChange: (body: string) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  placeholder: string;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const commandListId = useId();
  const lastBodyRef = useRef(body);
  const [slash, setSlash] = useState<{ query: string; top: number } | null>(null);
  const [activeCommand, setActiveCommand] = useState(0);
  const commands = slash === null ? [] : slashCommands.filter((command) => `${command.id} ${command.label}`.toLowerCase().includes(slash.query));

  useEffect(() => {
    if (!slash || !commands.length) return;
    document.getElementById(`${commandListId}-${commands[activeCommand]?.id}`)?.scrollIntoView({ block: "nearest" });
  }, [activeCommand, commandListId, commands, slash]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const externallyFilledEmptyEditor = Boolean(body.trim()) && !editor.textContent?.trim();
    if (editor.innerHTML === "" || externallyFilledEmptyEditor || (lastBodyRef.current !== body && document.activeElement !== editor)) {
      editor.innerHTML = markdownToEditorHtml(body);
      if (!body.trim() && editor.firstElementChild) (editor.firstElementChild as HTMLElement).dataset.placeholder = placeholder;
      lastBodyRef.current = body;
    }
    if (autoFocus) editor.focus();
  }, [autoFocus, body, placeholder]);

  function emitChange() {
    const editor = editorRef.current;
    if (!editor) return;
    const nextBody = editorToMarkdown(editor);
    lastBodyRef.current = nextBody;
    onChange(nextBody);
  }

  function updateSlashMenu() {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.anchorNode || !editor.contains(selection.anchorNode)) {
      setSlash(null);
      return;
    }
    const block = closestEditorBlock(selection.anchorNode, editor);
    const match = block?.textContent?.match(/^\/([a-z]*)$/i);
    if (!block || !match) {
      setSlash(null);
      return;
    }
    const query = match[1]!.toLowerCase();
    const matchingCommandCount = slashCommands.filter((command) => `${command.id} ${command.label}`.toLowerCase().includes(query)).length;
    const estimatedMenuHeight = Math.min(240, 30 + matchingCommandCount * 38);
    const fieldRect = editor.parentElement?.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    const topBelowLine = fieldRect ? blockRect.bottom - fieldRect.top + 6 : block.offsetTop + block.offsetHeight + 6;
    const topAboveLine = fieldRect ? blockRect.top - fieldRect.top - estimatedMenuHeight - 6 : 0;
    const hasRoomBelow = window.innerHeight - blockRect.bottom >= estimatedMenuHeight + 12;
    setActiveCommand(0);
    setSlash({ query, top: hasRoomBelow ? topBelowLine : Math.max(0, topAboveLine) });
  }

  function onInput(_event: FormEvent<HTMLDivElement>) {
    emitChange();
    updateSlashMenu();
  }

  function runCommand(command: SlashCommand) {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.anchorNode) return;
    const block = closestEditorBlock(selection.anchorNode, editor);
    if (!block) return;
    const next = createCommandBlock(command);
    if (Array.isArray(next)) {
      block.replaceWith(...next);
      placeCaret(next[next.length - 1]!);
    } else {
      block.replaceWith(next);
      placeCaret(next);
    }
    setSlash(null);
    emitChange();
  }

  function runToolbar(command: "bold" | "italic" | "insertUnorderedList" | "blockquote") {
    editorRef.current?.focus();
    if (command === "blockquote") document.execCommand("formatBlock", false, "blockquote");
    else document.execCommand(command);
    emitChange();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (slash) {
      if (event.key === "Escape") {
        event.preventDefault();
        setSlash(null);
        return;
      }
      if (!commands.length) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveCommand((current) => (current + 1) % commands.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveCommand((current) => (current - 1 + commands.length) % commands.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        runCommand(commands[activeCommand] ?? commands[0]!);
        return;
      }
    }
  }

  return (
    <div className="compose-writing-field">
      <div aria-label="Formatting" className="compose-formatting" role="toolbar">
        <button aria-label="Bold, Command B" onClick={() => runToolbar("bold")} type="button"><strong>B</strong></button>
        <button aria-label="Italic, Command I" onClick={() => runToolbar("italic")} type="button"><em>I</em></button>
        <button aria-label="Bulleted list" onClick={() => runToolbar("insertUnorderedList")} type="button">List</button>
        <button aria-label="Quote" onClick={() => runToolbar("blockquote")} type="button">Quote</button>
        <button aria-label="Attach files" className="compose-attach-quiet" disabled={!canAttach} onClick={onAttachClick} type="button">Attach</button>
        <span>Type / for structure · drop anywhere to attach</span>
      </div>
      <div
        aria-activedescendant={slash && commands.length ? `${commandListId}-${commands[activeCommand]?.id}` : undefined}
        aria-autocomplete={slash && commands.length ? "list" : undefined}
        aria-controls={slash ? commandListId : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        aria-label="Message body"
        aria-multiline="true"
        className="compose-writing-area compose-block-editor"
        contentEditable
        data-placeholder={placeholder}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          event.preventDefault();
          document.execCommand("insertText", false, normalizePastedText(event.clipboardData.getData("text")));
        }}
        ref={(editor) => { editorRef.current = editor; focusRef.current = editor; }}
        role="textbox"
        spellCheck
        suppressContentEditableWarning
      />
      {slash ? (
        <div aria-label="Writing commands" className="compose-command-menu" id={commandListId} role={commands.length ? "listbox" : "status"} style={{ top: slash.top }}>
          <p>Shape this block <span>↑↓ to move · ↵ to select</span></p>
          {commands.length ? commands.map((command, index) => (
            <button aria-selected={index === activeCommand} id={`${commandListId}-${command.id}`} key={command.id} onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand(command)} role="option" type="button">
              <span>/{command.id}</span><strong>{command.label}</strong><small>{command.hint}</small>
            </button>
          )) : <span className="compose-command-empty">No commands found · Esc to close</span>}
        </div>
      ) : null}
      {attachments.length ? (
        <ul aria-label={attachments.length === 1 ? "1 attachment" : `${attachments.length} attachments`} className="compose-attachment-chips">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              {attachment.previewUrl ? (
                <img alt="" className="compose-attachment-chip-preview" src={attachment.previewUrl} />
              ) : (
                <span aria-hidden="true" className="compose-attachment-chip-glyph">↳</span>
              )}
              <span className="compose-attachment-chip-meta">
                <strong title={attachment.filename}>{attachment.filename}</strong>
                <small>{formatAttachmentSize(attachment.size)}</small>
              </span>
              <button aria-label={`Remove ${attachment.filename}`} onClick={() => onRemoveAttachment(attachment.id)} type="button">×</button>
            </li>
          ))}
        </ul>
      ) : null}
      <span className="sr-only">Use Command B for bold, Command I for italic, Command Z to undo, and arrow keys to move through slash commands. Drop files onto the compose canvas to attach them.</span>
    </div>
  );
}

function ComposeDropOverlay() {
  return (
    <div aria-hidden="true" className="compose-drop-overlay">
      <strong>Drop to attach</strong>
      <span>Images and files land here — the writing canvas stays clear until then.</span>
    </div>
  );
}

function ComposeDeliveryBar({ actionLabel = "Send", canSend, controller, deliveryError, deliveryReady, deliveryReason, deliveryReasonId, deliveryStatus = "idle", onDiscard, onRequestSendAccess, onSend }: { actionLabel?: string; canSend: boolean; controller: ComposeDraftController; deliveryError?: string | null; deliveryReady: boolean; deliveryReason: string; deliveryReasonId: string; deliveryStatus?: ComposeDeliveryStatus; onDiscard: () => void; onRequestSendAccess?: () => void; onSend?: () => Promise<void> }) {
  const {
    draft,
    hasContent,
    saveStatus,
    saveMessage = saveStatus === "saved" ? (draft.attachments.length ? "Text saved" : "Saved on this device") : saveStatus === "saving" ? "Saving…" : "Couldn’t save — keep this tab open",
    retrySave = () => {},
  } = controller;
  const deliveryProgress = draft.body.trim()
    ? `${draft.body.trim().split(/\s+/).length} words`
    : draft.attachments.length
      ? `Attachment-only ${actionLabel === "Send" ? "message" : actionLabel.toLowerCase()}`
      : "A blank page";
  return (
    <footer className="compose-delivery-bar">
      <div><DraftStatus hasSessionAttachments={draft.attachments.length > 0} message={saveMessage} onRetry={retrySave} status={saveStatus} /><span className={draft.body.trim() ? "compose-delivery-word-count" : "compose-delivery-empty"}>{deliveryProgress}</span></div>
      <div className="compose-delivery-actions">
        {hasContent ? <button className="compose-discard" onClick={onDiscard} type="button">Discard</button> : null}
        <button
          aria-describedby={deliveryReasonId}
          aria-disabled={!deliveryReady || undefined}
          className="compose-send"
          disabled={deliveryStatus === "sending" || deliveryStatus === "sent" || (!canSend && !onRequestSendAccess)}
          onClick={() => void onSend?.()}
          type="button"
        >{deliveryStatus === "sending" ? "Sending…" : canSend ? actionLabel === "Send" ? "Send" : `Send ${actionLabel.toLowerCase()}` : "Enable sending"}</button>
      </div>
      <p aria-live="polite" className={deliveryError ? "compose-delivery-error" : undefined} id={deliveryReasonId} role={deliveryError ? "alert" : undefined}>{deliveryError ?? (deliveryStatus === "sent" ? "Sent. The conversation is refreshing." : deliveryReason)}</p>
    </footer>
  );
}

function DraftConflictNotice({ conflict, onResolve }: { conflict: ComposeDraftConflict; onResolve: (choice: "server" | "local") => Promise<void> }) {
  return (
    <section aria-label="Draft recovery choice" className="compose-conflict" role="alert">
      <div>
        <strong>This draft changed in another tab.</strong>
        <span>The newer saved copy is from {new Date(conflict.server.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Your words are still safe on this device.</span>
      </div>
      <div>
        <button onClick={() => void onResolve("server")} type="button">Use newer version</button>
        <button onClick={() => void onResolve("local")} type="button">Keep mine as a new draft</button>
      </div>
    </section>
  );
}

async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function hashText(value: string) {
  return [...value].reduce((hash, character) => ((hash << 5) - hash + character.charCodeAt(0)) | 0, 0) >>> 0;
}

function closestEditorBlock(node: Node, editor: HTMLElement) {
  let current = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement;
  while (current && current.parentElement !== editor) current = current.parentElement;
  return current?.parentElement === editor ? current : null;
}

function createCommandBlock(command: SlashCommand): HTMLElement | HTMLElement[] {
  if (command.block === "divider") {
    const divider = document.createElement("hr");
    const paragraph = document.createElement("p");
    paragraph.append(document.createElement("br"));
    return [divider, paragraph];
  }
  if (command.block === "bullets" || command.block === "numbered") {
    const list = document.createElement(command.block === "bullets" ? "ul" : "ol");
    const item = document.createElement("li");
    item.append(document.createElement("br"));
    list.append(item);
    return list;
  }
  const block = document.createElement(command.block === "heading" ? "h2" : command.block === "quote" ? "blockquote" : "p");
  block.append(document.createElement("br"));
  return block;
}

function placeCaret(element: HTMLElement) {
  const target = element.matches("ul, ol") ? element.querySelector("li") ?? element : element;
  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  (element.closest("[contenteditable]") as HTMLElement | null)?.focus();
}

export function markdownToEditorHtml(markdown: string) {
  if (!markdown.trim()) return "<p><br></p>";
  const lines = normalizePastedText(markdown).split("\n");
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^- /.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^- /.test(lines[index]!)) { items.push(`<li>${renderInlineMarkdown(lines[index]!.slice(2)) || "<br>"}</li>`); index += 1; }
      index -= 1;
      blocks.push(`<ul>${items.join("")}</ul>`);
    } else if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\. /.test(lines[index]!)) { items.push(`<li>${renderInlineMarkdown(lines[index]!.replace(/^\d+\. /, "")) || "<br>"}</li>`); index += 1; }
      index -= 1;
      blocks.push(`<ol>${items.join("")}</ol>`);
    } else if (line.startsWith("## ")) blocks.push(`<h2>${renderInlineMarkdown(line.slice(3)) || "<br>"}</h2>`);
    else if (line.startsWith("> ")) blocks.push(`<blockquote>${renderInlineMarkdown(line.slice(2)) || "<br>"}</blockquote>`);
    else if (line.trim() === "---") blocks.push("<hr>");
    else blocks.push(`<p>${renderInlineMarkdown(line) || "<br>"}</p>`);
  }
  return blocks.join("");
}

function renderInlineMarkdown(value: string) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/_(.+?)_/g, "<em>$1</em>");
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function editorToMarkdown(editor: HTMLElement) {
  return [...editor.childNodes].map((node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();
    if (tag === "h2") return `## ${inlineNodeToMarkdown(element)}`.trimEnd();
    if (tag === "blockquote") return `> ${inlineNodeToMarkdown(element)}`.trimEnd();
    if (tag === "hr") return "---";
    if (tag === "ul" || tag === "ol") return [...element.children].map((item, index) => `${tag === "ul" ? "-" : `${index + 1}.`} ${inlineNodeToMarkdown(item)}`.trimEnd()).join("\n");
    return inlineNodeToMarkdown(element);
  }).join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function inlineNodeToMarkdown(node: Node): string {
  return [...node.childNodes].map((child) => {
    if (child.nodeType === Node.TEXT_NODE) return child.textContent ?? "";
    const element = child as HTMLElement;
    const content = inlineNodeToMarkdown(element);
    if (element.matches("strong, b")) return `**${content}**`;
    if (element.matches("em, i")) return `_${content}_`;
    if (element.matches("br")) return "";
    return content;
  }).join("");
}

function RecipientField({ autoFocus, contacts, error, inputRef, kind, label, onChange, onErrorChange, onQueryChange, query, recipients }: {
  autoFocus?: boolean;
  contacts: MailContact[];
  error: string;
  inputRef: (input: HTMLInputElement | null) => void;
  kind: RecipientKind;
  label: string;
  onChange: (recipients: MailContact[]) => void;
  onErrorChange: (error: string) => void;
  onQueryChange: (query: string) => void;
  query: string;
  recipients: MailContact[];
}) {
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);
  const localInputRef = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const errorId = useId();
  const suggestionListId = useId();
  const recipientEmails = useMemo(() => new Set(recipients.map((recipient) => recipient.email.toLowerCase())), [recipients]);
  const suggestions = query.trim().length === 0 ? [] : contacts.filter((contact) => {
    const needle = query.toLowerCase();
    return !recipientEmails.has(contact.email.toLowerCase()) && `${contact.name ?? ""} ${contact.email}`.toLowerCase().includes(needle);
  }).slice(0, 5);

  useEffect(() => { if (autoFocus) localInputRef.current?.focus(); }, [autoFocus]);
  useEffect(() => { setActiveSuggestion((current) => suggestions.length ? Math.min(current, suggestions.length - 1) : 0); }, [suggestions.length]);
  useEffect(() => {
    if (!suggestions.length || !suggestionsOpen) return;
    document.getElementById(`${suggestionListId}-${activeSuggestion}`)?.scrollIntoView({ block: "nearest" });
  }, [activeSuggestion, suggestionListId, suggestions.length, suggestionsOpen]);

  function addContacts(next: MailContact[]) {
    const merged = [...recipients];
    const seen = new Set(recipientEmails);
    for (const contact of next) {
      if (!seen.has(contact.email.toLowerCase())) {
        merged.push(contact);
        seen.add(contact.email.toLowerCase());
      }
    }
    onChange(merged);
    onQueryChange("");
    setActiveSuggestion(0);
    setSuggestionsOpen(false);
    onErrorChange("");
  }

  function commitQuery() {
    if (!query.trim()) return;
    const parsed = parseRecipientInput(query);
    if (parsed.invalid.length > 0 || parsed.contacts.length === 0) {
      onErrorChange(recipientValidationMessage(parsed.invalid.length ? parsed.invalid : [query.trim()]));
      return;
    }
    addContacts(parsed.contacts);
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    if (!/[\n,;]/.test(pasted)) return;
    event.preventDefault();
    const nextQuery = `${query}${pasted}`;
    const parsed = parseRecipientInput(nextQuery);
    onQueryChange(nextQuery);
    window.setTimeout(() => {
      if (parsed.invalid.length > 0 || parsed.contacts.length === 0) onErrorChange(recipientValidationMessage(parsed.invalid.length ? parsed.invalid : [nextQuery.trim()]));
      else addContacts(parsed.contacts);
    }, 0);
  }

  return (
    <div className="compose-recipient-row">
      <span className="compose-recipient-label" id={labelId}>{label}</span>
      <div className={`compose-recipient-box${error ? " compose-recipient-box-error" : ""}`}>
        {recipients.map((recipient) => (
          <span className="compose-recipient-chip" key={recipient.email}>
            <span>{recipient.name ?? recipient.email}</span>
            <button aria-label={`Remove ${recipient.name ?? recipient.email} from ${label}`} onClick={() => onChange(recipients.filter((item) => item.email !== recipient.email))} type="button">×</button>
          </span>
        ))}
        <input
          aria-label={`Add ${label} recipient`}
          aria-autocomplete="list"
          aria-activedescendant={suggestionsOpen && suggestions.length ? `${suggestionListId}-${activeSuggestion}` : undefined}
          aria-controls={suggestionsOpen && suggestions.length ? suggestionListId : undefined}
          aria-describedby={error ? errorId : undefined}
          aria-expanded={suggestionsOpen && suggestions.length > 0}
          aria-invalid={Boolean(error)}
          autoComplete="off"
          name={`${kind}-recipient`}
          onBlur={() => { if (query.trim() && suggestions.length === 0) commitQuery(); }}
          onInput={(event) => { onQueryChange(event.currentTarget.value); setActiveSuggestion(0); setSuggestionsOpen(true); onErrorChange(""); }}
          onKeyDown={(event) => {
            if (suggestionsOpen && suggestions.length && event.key === "ArrowDown") { event.preventDefault(); setActiveSuggestion((current) => (current + 1) % suggestions.length); return; }
            if (suggestionsOpen && suggestions.length && event.key === "ArrowUp") { event.preventDefault(); setActiveSuggestion((current) => (current - 1 + suggestions.length) % suggestions.length); return; }
            if (event.key === "Escape" && suggestionsOpen && suggestions.length) { event.preventDefault(); setSuggestionsOpen(false); return; }
            if ((event.key === "Enter" || event.key === "," || event.key === ";") && query.trim()) { event.preventDefault(); suggestionsOpen && suggestions.length ? addContacts([suggestions[activeSuggestion] ?? suggestions[0]!]) : commitQuery(); }
            if (event.key === "Backspace" && !query && recipients.length) onChange(recipients.slice(0, -1));
          }}
          onPaste={onPaste}
          placeholder={recipients.length ? "Add another…" : "maya@example.com…"}
          ref={(input) => { localInputRef.current = input; inputRef(input); }}
          role="combobox"
          spellCheck={false}
          type="email"
          value={query}
        />
        {suggestionsOpen && suggestions.length > 0 ? (
          <div className="compose-recipient-suggestions" id={suggestionListId} role="listbox">
            {suggestions.map((contact, index) => <button aria-selected={index === activeSuggestion} id={`${suggestionListId}-${index}`} key={contact.email} onMouseEnter={() => setActiveSuggestion(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => addContacts([contact])} role="option" type="button"><strong>{contact.name ?? contact.email}</strong><span>{contact.email}</span></button>)}
          </div>
        ) : null}
      </div>
      {error ? <p className="compose-recipient-error" id={errorId} role="alert">{error}</p> : null}
    </div>
  );
}

function DraftStatus({ hasSessionAttachments, message, onRetry, status }: { hasSessionAttachments: boolean; message: string; onRetry: () => void; status: ComposeSaveStatus }) {
  const label = hasSessionAttachments && status === "saved"
    ? `${message} · attachments stay until you close this tab`
    : message;
  return (
    <span aria-live="polite" className={`compose-save-status compose-save-status-${status}`}>
      <span aria-hidden="true" />
      {label}
      {status === "failed" ? <button className="compose-save-retry" onClick={onRetry} type="button">Retry</button> : null}
    </span>
  );
}

function getSlashQuery(body: string, cursor: number) {
  const line = body.slice(body.lastIndexOf("\n", cursor - 1) + 1, cursor);
  const match = line.match(/^\/([a-z]*)$/i);
  return match ? match[1]!.toLowerCase() : null;
}

function normalizePastedText(value: string) {
  return value.replace(/\r\n?/g, "\n").replace(/[\u00a0\u2007\u202f]/g, " ");
}
