export type FeedbackKind = "bug" | "idea" | "question" | "other";
export type FeedbackSeverity = "low" | "normal" | "high" | "urgent";

export interface FeedbackProject {
  id: string;
  name: string;
  version?: string;
  environment?: string;
}

export interface FeedbackAttachment {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  source: "automatic-screenshot" | "upload" | "clipboard";
}

export interface FeedbackElementContext {
  selector: string;
  tagName: string;
  text?: string;
  ariaLabel?: string;
  role?: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  html?: string;
}

export interface FeedbackRuntimeContext {
  url: string;
  route: string;
  title: string;
  userAgent: string;
  viewport: { width: number; height: number; pixelRatio: number };
  locale: string;
  timezone: string;
  capturedAt: string;
}

export interface FeedbackScope {
  title: string;
  summary: string;
  reproductionSteps: string[];
  expectedBehavior: string;
  actualBehavior: string;
  acceptanceCriteria: string[];
  technicalNotes: string[];
  openQuestions: string[];
  confidence: "low" | "medium" | "high";
}

export interface FeedbackScopingMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export interface FeedbackScopingResult {
  message: string;
  complete: boolean;
  scope?: FeedbackScope;
}

export interface FeedbackReport {
  schemaVersion: 1;
  id: string;
  project: FeedbackProject;
  kind: FeedbackKind;
  severity: FeedbackSeverity;
  title: string;
  description: string;
  reporter?: { id?: string; name?: string; email?: string };
  context: FeedbackRuntimeContext;
  elements: FeedbackElementContext[];
  state?: unknown;
  metadata?: Record<string, unknown>;
  attachments: FeedbackAttachment[];
  scope?: FeedbackScope;
  scopingConversation?: FeedbackScopingMessage[];
}

export interface FeedbackSubmissionResult {
  id: string;
  identifier?: string;
  url?: string;
  title?: string;
}

export type FeedbackSubmitter = (
  report: FeedbackReport,
) => Promise<FeedbackSubmissionResult>;

export type FeedbackScoper = (
  report: FeedbackReport,
  messages: FeedbackScopingMessage[],
) => Promise<FeedbackScopingResult>;

export const DEFAULT_REDACT_KEYS = [
  "password",
  "passwd",
  "secret",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "authorization",
  "cookie",
  "session",
  "creditCard",
  "ssn",
];

export interface RedactOptions {
  keys?: string[];
  replacement?: string;
  maxDepth?: number;
}

export function redactState(value: unknown, options: RedactOptions = {}): unknown {
  const keys = new Set(
    [...DEFAULT_REDACT_KEYS, ...(options.keys ?? [])].map((key) =>
      key.toLowerCase(),
    ),
  );
  const replacement = options.replacement ?? "[REDACTED]";
  const maxDepth = options.maxDepth ?? 8;
  const seen = new WeakSet<object>();

  function visit(current: unknown, depth: number): unknown {
    if (depth > maxDepth) return "[MAX_DEPTH]";
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "number" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "bigint") return current.toString();
    if (typeof current === "undefined") return null;
    if (typeof current === "function" || typeof current === "symbol") {
      return `[${typeof current}]`;
    }
    if (current instanceof Date) return current.toISOString();
    if (current instanceof Error) {
      return { name: current.name, message: current.message, stack: current.stack };
    }
    if (typeof current !== "object") return String(current);
    if (seen.has(current)) return "[CIRCULAR]";
    seen.add(current);

    if (Array.isArray(current)) {
      return current.map((item) => visit(item, depth + 1));
    }

    return Object.fromEntries(
      Object.entries(current).map(([key, item]) => [
        key,
        keys.has(key.toLowerCase()) ? replacement : visit(item, depth + 1),
      ]),
    );
  }

  return visit(value, 0);
}

export function validateFeedbackReport(
  value: unknown,
): { ok: true; report: FeedbackReport } | { ok: false; error: string } {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "Feedback body must be an object." };
  }
  const report = value as Partial<FeedbackReport>;
  if (report.schemaVersion !== 1) {
    return { ok: false, error: "Unsupported feedback schema version." };
  }
  if (!report.project?.id || !report.project.name) {
    return { ok: false, error: "Project id and name are required." };
  }
  if (!report.title?.trim() || !report.description?.trim()) {
    return { ok: false, error: "Title and description are required." };
  }
  if (!Array.isArray(report.attachments)) {
    return { ok: false, error: "Attachments must be an array." };
  }
  if (!Array.isArray(report.elements)) {
    return { ok: false, error: "Elements must be an array." };
  }
  return { ok: true, report: report as FeedbackReport };
}
