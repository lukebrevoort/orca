import {
  redactState,
  validateFeedbackReport,
  type FeedbackReport,
  type FeedbackSubmissionResult,
} from "@feedback-kit/core";
import { readBoundedRequestBody } from "./request-body.ts";

const MAX_FEEDBACK_BODY_BYTES = 40 * 1024 * 1024;
const MAX_FEEDBACK_RECEIPTS = 500;
const FEEDBACK_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

export type FeedbackReceipt = {
  id: string;
  projectId: string;
  title: string;
  route: string;
  receivedAt: string;
};

export type FeedbackDelivery = Pick<
  FeedbackSubmissionResult,
  "identifier" | "url"
>;

const feedbackReceipts = new Map<string, FeedbackReceipt>();

export function getFeedbackReceipt(id: string, now = new Date()) {
  const receipt = feedbackReceipts.get(id);
  if (receipt && now.getTime() - Date.parse(receipt.receivedAt) >= FEEDBACK_RECEIPT_TTL_MS) {
    feedbackReceipts.delete(id);
    return undefined;
  }
  return receipt;
}

export async function handleFeedbackRequest(
  request: Request,
  options: {
    allowedOrigin?: string;
    enabled?: boolean;
    now?: () => Date;
    onReport?: (
      report: FeedbackReport,
    ) => void | FeedbackDelivery | Promise<void | FeedbackDelivery>;
  } = {},
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    vary: "origin",
  });
  const origin = request.headers.get("origin");
  if (origin && options.allowedOrigin && origin !== options.allowedOrigin) {
    return Response.json({ error: "Feedback origin is not allowed." }, { status: 403, headers });
  }
  if (origin && options.allowedOrigin) {
    headers.set("access-control-allow-origin", options.allowedOrigin);
    headers.set("access-control-allow-methods", "POST, OPTIONS");
    headers.set("access-control-allow-headers", "content-type");
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405, headers });
  }
  if (options.enabled === false) {
    return Response.json({ error: "Feedback is not enabled." }, { status: 404, headers });
  }

  try {
    const bytes = await readBoundedRequestBody(request, MAX_FEEDBACK_BODY_BYTES);
    if (bytes === null) {
      return Response.json({ error: "Feedback payload is too large." }, { status: 413, headers });
    }
    const body = new TextDecoder().decode(bytes);
    const parsed: unknown = JSON.parse(body);
    const candidate = parsed as Partial<FeedbackReport> | null;
    // Preserve early library rejections that are safe without string methods.
    // Other malformed fields must be rejected before validation can call trim().
    const hasLegacyRejection =
      !candidate || typeof candidate !== "object" ||
      candidate.schemaVersion !== 1 ||
      !candidate.project?.id || !candidate.project.name ||
      candidate.title == null ||
      (typeof candidate.title === "string" && (
        !candidate.title.trim() || candidate.description == null ||
        (typeof candidate.description === "string" && !candidate.description.trim())
      ));
    const isObject = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === "object" && !Array.isArray(value);
    if (!hasLegacyRejection && (
      !isObject(parsed) ||
      typeof parsed.id !== "string" ||
      typeof parsed.title !== "string" ||
      typeof parsed.description !== "string" ||
      !isObject(parsed.project) ||
      typeof parsed.project.id !== "string" ||
      typeof parsed.project.name !== "string" ||
      !isObject(parsed.context) ||
      typeof parsed.context.route !== "string"
    )) {
      return Response.json({ error: "Feedback field is invalid." }, { status: 400, headers });
    }
    const validation = validateFeedbackReport(parsed);
    if (!validation.ok) {
      return Response.json({ error: validation.error }, { status: 400, headers });
    }

    const validatedReport = validation.report;
    if (
      validatedReport.id.length > 128 ||
      validatedReport.title.length > 200 ||
      validatedReport.project.id.length > 128 ||
      validatedReport.context.route.length > 2048
    ) {
      return Response.json({ error: "Feedback field is too long." }, { status: 400, headers });
    }

    const now = (options.now ?? (() => new Date()))();
    const report: FeedbackReport = {
      ...validation.report,
      ...(validation.report.state === undefined
        ? {}
        : { state: redactState(validation.report.state) }),
    };
    const receipt: FeedbackReceipt = {
      id: report.id,
      projectId: report.project.id,
      title: report.title,
      route: report.context.route,
      receivedAt: now.toISOString(),
    };
    for (const id of feedbackReceipts.keys()) getFeedbackReceipt(id, now);
    feedbackReceipts.delete(receipt.id);
    feedbackReceipts.set(receipt.id, receipt);
    while (feedbackReceipts.size > MAX_FEEDBACK_RECEIPTS) {
      const oldestId = feedbackReceipts.keys().next().value;
      if (oldestId !== undefined) feedbackReceipts.delete(oldestId);
    }
    const delivery = await options.onReport?.(report);
    console.info("Feedback received", receipt);
    return Response.json({
      result: {
        id: receipt.id,
        title: receipt.title,
        ...(delivery ?? {}),
      },
    }, { status: 201, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown feedback submission error.";
    console.error("Feedback submission failed", { message });
    return Response.json(
      {
        error: process.env.NODE_ENV === "production"
          ? "Feedback could not be submitted."
          : message,
      },
      { status: 400, headers },
    );
  }
}
