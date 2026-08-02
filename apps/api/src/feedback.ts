import {
  redactState,
  validateFeedbackReport,
  type FeedbackReport,
  type FeedbackSubmissionResult,
} from "@feedback-kit/core";

const MAX_FEEDBACK_BODY_BYTES = 40 * 1024 * 1024;

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

export function getFeedbackReceipt(id: string) {
  return feedbackReceipts.get(id);
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
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_FEEDBACK_BODY_BYTES) {
      return Response.json({ error: "Feedback payload is too large." }, { status: 413, headers });
    }
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_FEEDBACK_BODY_BYTES) {
      return Response.json({ error: "Feedback payload is too large." }, { status: 413, headers });
    }
    const validation = validateFeedbackReport(JSON.parse(body));
    if (!validation.ok) {
      return Response.json({ error: validation.error }, { status: 400, headers });
    }

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
      receivedAt: (options.now ?? (() => new Date()))().toISOString(),
    };
    feedbackReceipts.set(receipt.id, receipt);
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
