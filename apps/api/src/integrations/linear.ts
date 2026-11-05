import { createHash } from "node:crypto";
import type {
  FeedbackReport,
  FeedbackSeverity,
} from "@feedback-kit/core";

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const LINEAR_DESCRIPTION_LIMIT = 250_000;

type DeliveryStage = "reconcile" | "upload_prepare" | "upload_put" | "create";
type UploadFailureReason = "upload_graphql" | "upload_response" | "upload_url_parse" | "upload_url_protocol" | "upload_url_userinfo" | "upload_url_port" | "upload_url_fragment" | "upload_url_bucket" | "upload_url_host" | "asset_url" | "upload_headers";
class UploadPreparationError extends Error {
  constructor(readonly reason: UploadFailureReason) { super("Linear upload preparation failed"); }
}
type DeliveryDiagnostic = { stage: DeliveryStage | "unknown"; status: number | null; reason: "timeout" | "failed" | UploadFailureReason };
const deliveryDiagnostics = new WeakMap<object, DeliveryDiagnostic>();

// Never serialize upstream messages, URLs, GraphQL variables, or Error objects.
export function feedbackDeliveryDiagnostic(error: unknown): DeliveryDiagnostic {
  const diagnostic = error !== null && typeof error === "object" ? deliveryDiagnostics.get(error) : undefined;
  return diagnostic ? { ...diagnostic } : { stage: "unknown", status: null, reason: "failed" };
}

type DeliveryFetch = (stage: DeliveryStage, input: string, init: RequestInit) => Promise<Response>;


const FILE_UPLOAD_MUTATION = `
  mutation UploadFeedbackFile($contentType: String!, $filename: String!, $size: Int!) {
    fileUpload(contentType: $contentType, filename: $filename, size: $size, makePublic: false) {
      success
      uploadFile {
        uploadUrl
        assetUrl
        headers {
          key
          value
        }
      }
    }
  }
`;

const DEFAULT_LINEAR_DESTINATION = {
  teamId: "16291d5a-b027-48d5-b0c5-6a6e288dac0a",
  projectId: "8aaaf368-8ab6-43be-ba51-33560f289a39",
  feedbackLabelId: "73b02aaa-6ef9-4c46-9304-cd5f1753f4dd",
  backlogStateId: "83b363c2-51a7-405f-9063-e3bbb03c2ff0",
  assigneeId: "47ec32ea-723b-44fc-a275-02069b3c2805",
} as const;

const PRIORITY_BY_SEVERITY: Record<FeedbackSeverity, number> = {
  low: 4,
  normal: 3,
  high: 2,
  urgent: 1,
};

const ISSUE_CREATE_MUTATION = `
  mutation CreateFeedbackIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        identifier
        title
        url
      }
    }
  }
`;

type LinearIssue = {
  identifier: string;
  title: string;
  url: string;
};

type LinearGraphQLError = {
  message?: string;
  extensions?: {
    userPresentableMessage?: string;
    validationErrors?: Array<{
      property?: string;
      constraints?: Record<string, string>;
    }>;
  };
};

type LinearResponse = {
  data?: {
    issueCreate?: {
      success: boolean;
      issue?: LinearIssue | null;
    };
  };
  errors?: LinearGraphQLError[];
};

type LinearEnvironment = Record<string, string | undefined>;

function valueOrDefault(
  environment: LinearEnvironment,
  name: string,
  fallback: string,
): string {
  return environment[name]?.trim() || fallback;
}

function formatJson(value: unknown): string {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

function linearErrorMessage(errors: LinearGraphQLError[] | undefined): string | undefined {
  const graphQLError = errors?.find((error) => error.message);
  const validationError = graphQLError?.extensions?.validationErrors?.[0];
  return (
    graphQLError?.extensions?.userPresentableMessage ??
    (validationError?.property && validationError.constraints
      ? `${validationError.property}: ${Object.values(validationError.constraints).join(", ")}`
      : undefined) ??
    graphQLError?.message
  );
}

function formatDescription(
  report: FeedbackReport,
  attachmentUrls: ReadonlyMap<string, string>,
): string {
  const context = [
    `- Type: ${report.kind}`,
    `- Severity: ${report.severity}`,
    `- Route: \`${report.context.route}\``,
    `- URL: ${report.context.url}`,
    `- Browser: ${report.context.userAgent}`,
    `- Report ID: \`${report.id}\``,
  ].join("\n");

  const elements = report.elements.length
    ? report.elements
        .map((element) => {
          const text = element.text ? ` — ${element.text}` : "";
          return `- \`${element.selector}\`${text}`;
        })
        .join("\n")
    : "None";

  const attachments = report.attachments.length
    ? report.attachments
        .map((attachment) => {
          const assetUrl = attachmentUrls.get(attachment.id)?.replace(/[()[\]<>\\]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
          if (!assetUrl) {
            return `- ${attachment.name} (${attachment.mimeType})`;
          }
          if (attachment.mimeType.startsWith("image/")) {
            return `![${markdownLabel(attachment.name)}](${assetUrl})`;
          }
          return `[${markdownLabel(attachment.name)}](${assetUrl})`;
        })
        .join("\n")
    : "None";

  return [
    "## What happened",
    report.description,
    "",
    "## Feedback context",
    context,
    "",
    "## Selected elements",
    elements,
    "",
    "## Attachments",
    attachments,
    ...(report.state === undefined
      ? []
      : ["", "## Orca state", formatJson(report.state)]),
    ...(report.metadata === undefined
      ? []
      : ["", "## Metadata", formatJson(report.metadata)]),
  ].join("\n");
}

function decodeDataUrl(dataUrl: string): Uint8Array {
  const commaIndex = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || commaIndex < 0) {
    throw new Error("Feedback attachment is not a valid data URL.");
  }

  const header = dataUrl.slice(5, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  if (header.split(";").includes("base64")) {
    return Uint8Array.from(Buffer.from(payload, "base64"));
  }
  return Uint8Array.from(Buffer.from(decodeURIComponent(payload), "utf8"));
}

function markdownLabel(value: string) {
  return value.replace(/[\\[\]()!*_<>`]/g, "\\$&").replace(/[\r\n]/g, " ");
}
function validateUploadUrls(uploadUrl: string, assetUrl: string) {
  let upload: URL, asset: URL;
  try { upload = new URL(uploadUrl); } catch { throw new UploadPreparationError("upload_url_parse"); }
  try { asset = new URL(assetUrl); } catch { throw new UploadPreparationError("asset_url"); }
  const secure = (url: URL) => url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash;
  const googleBucket = upload.hostname === "storage.googleapis.com" &&
    (/^\/linear-[a-z0-9-]+\//.test(upload.pathname) || upload.pathname.startsWith("/uploads.linear.app/"));
  const googleBucketHost = /^linear-[a-z0-9-]+\.storage\.googleapis\.com$/.test(upload.hostname);
  // Fixed codes only. Preserve parsing/check precedence and restrict uploads to known destinations.
  if (upload.protocol !== "https:") throw new UploadPreparationError("upload_url_protocol");
  if (upload.username || upload.password) throw new UploadPreparationError("upload_url_userinfo");
  if (upload.port) throw new UploadPreparationError("upload_url_port");
  if (upload.hash) throw new UploadPreparationError("upload_url_fragment");
  if (!(googleBucket || googleBucketHost || upload.hostname === "uploads.linear.app")) {
    throw new UploadPreparationError(upload.hostname === "storage.googleapis.com" ? "upload_url_bucket" : "upload_url_host");
  }
  if (!secure(asset) || asset.hostname !== "uploads.linear.app" || asset.search || /\s/.test(assetUrl)) throw new UploadPreparationError("asset_url");
}

async function uploadAttachment(
  apiKey: string,
  attachment: FeedbackReport["attachments"][number],
  request: DeliveryFetch,
): Promise<string> {
  const bytes = decodeDataUrl(attachment.dataUrl);
  const response = await request("upload_prepare", LINEAR_GRAPHQL_ENDPOINT, {
    method: "POST",
    signal: AbortSignal.timeout(12_000),
    redirect: "error",
    headers: {
      authorization: apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: FILE_UPLOAD_MUTATION,
      variables: {
        contentType: attachment.mimeType,
        filename: attachment.name,
        size: bytes.byteLength,
      },
    }),
  });

  const payload: unknown = await response.json().catch(() => null);
  const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(payload)) throw new UploadPreparationError("upload_response");
  if ("errors" in payload && (!Array.isArray(payload.errors) || payload.errors.length > 0)) throw new UploadPreparationError("upload_graphql");
  const result = isObject(payload.data) ? payload.data.fileUpload : undefined;
  const uploadFile = isObject(result) ? result.uploadFile : undefined;
  if (!response.ok || !isObject(result) || result.success !== true || !isObject(uploadFile) ||
      typeof uploadFile.uploadUrl !== "string" || typeof uploadFile.assetUrl !== "string") {
    throw new UploadPreparationError("upload_response");
  }
  validateUploadUrls(uploadFile.uploadUrl, uploadFile.assetUrl);
  const uploadHeaders = new Headers({
    "Content-Type": attachment.mimeType,
    "Cache-Control": "private, no-store",
  });
  if (!Array.isArray(uploadFile.headers)) throw new UploadPreparationError("upload_headers");
  for (const header of uploadFile.headers) {
    if (!isObject(header) || typeof header.key !== "string" || typeof header.value !== "string" ||
        !/^(content-type|content-disposition|cache-control|x-goog-[a-z0-9-]+|x-amz-[a-z0-9-]+)$/i.test(header.key) || /[\r\n\0]/.test(header.value)) throw new UploadPreparationError("upload_headers");
    try { uploadHeaders.set(header.key, header.value); } catch { throw new UploadPreparationError("upload_headers"); }
  }

  const uploadResponse = await request("upload_put", uploadFile.uploadUrl, {
    method: "PUT",
    signal: AbortSignal.timeout(60_000),
    redirect: "error",
    headers: uploadHeaders,
    body: bytes as unknown as BodyInit,
  });
  if (!uploadResponse.ok) {
    throw new Error(`Linear attachment upload failed (${uploadResponse.status}).`);
  }

  return uploadFile.assetUrl;
}

export function createLinearFeedbackSubmitter(
  environment: LinearEnvironment = process.env,
): ((report: FeedbackReport, options?: { issueId: string }) => Promise<{
  identifier: string;
  url: string;
}>) | undefined {
  const apiKey = environment.LINEAR_API_KEY?.trim();
  if (!apiKey) return undefined;

  const destination = {
    teamId: valueOrDefault(environment, "LINEAR_TEAM_ID", DEFAULT_LINEAR_DESTINATION.teamId),
    projectId: valueOrDefault(environment, "LINEAR_PROJECT_ID", DEFAULT_LINEAR_DESTINATION.projectId),
    feedbackLabelId: valueOrDefault(
      environment,
      "LINEAR_FEEDBACK_LABEL_ID",
      DEFAULT_LINEAR_DESTINATION.feedbackLabelId,
    ),
    backlogStateId: valueOrDefault(
      environment,
      "LINEAR_FEEDBACK_STATE_ID",
      DEFAULT_LINEAR_DESTINATION.backlogStateId,
    ),
    assigneeId: valueOrDefault(
      environment,
      "LINEAR_ASSIGNEE_ID",
      DEFAULT_LINEAR_DESTINATION.assigneeId,
    ),
  };

  // Metadata only: private unsigned asset URLs, never bytes or signed PUT URLs.
  // No public deletion API exists. Do not invoke Linear's INTERNAL dangerous
  // deletion after a failure: an ambiguous create may already reference assets.
  // Partial uploads can remain private orphans after eviction/process restart.
  const uploads = new Map<string, { assetUrl: string; expiresAt: number }>();
  const uploadCacheTtlMs = 30 * 60 * 1000;
  const uploadCacheLimit = 100;
  return async (report, options) => {
    let stage: DeliveryStage = "create";
    let status: number | null = null;
    const request: DeliveryFetch = async (nextStage, input, init) => {
      stage = nextStage; status = null;
      const response = await fetch(input, init);
      status = response.status;
      return response;
    };
    try {
      // A server-derived UUID is also the Linear issue ID. Retrying an uncertain
      // create cannot create a second issue; recover the receipt by that exact ID.
      // Filtered lookup has a documented empty connection for absence, avoiding
      // undocumented error codes from issue(id:). Include archived tickets too.
      const recover = async () => {
        const response = await request("reconcile", LINEAR_GRAPHQL_ENDPOINT, {
          method: "POST", signal: AbortSignal.timeout(12_000), redirect: "error",
          headers: { authorization: apiKey, "content-type": "application/json" },
          body: JSON.stringify({ query: "query FeedbackIssue($id: ID!) { issues(filter: { id: { eq: $id } }, first: 1, includeArchived: true) { nodes { identifier url } } }", variables: { id: options!.issueId } }),
        });
        const payload: unknown = await response.json();
        const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
        if (!response.ok || !isObject(payload)) throw new Error("Could not reconcile Linear ticket");
        if ("errors" in payload && (!Array.isArray(payload.errors) || payload.errors.length > 0)) throw new Error("Could not reconcile Linear ticket");
        const nodes = isObject(payload.data) && isObject(payload.data.issues) ? payload.data.issues.nodes : undefined;
        if (!Array.isArray(nodes) || nodes.length > 1) throw new Error("Could not reconcile Linear ticket");
        if (nodes.length === 0) return null;
        const existing: unknown = nodes[0];
        if (!isObject(existing) || typeof existing.identifier !== "string" || !existing.identifier || typeof existing.url !== "string" || !existing.url) throw new Error("Could not reconcile Linear ticket");
        return { identifier: existing.identifier, url: existing.url };
      };
      if (options) {
        const existing = await recover();
        if (existing) return existing;
      }
      for (const [key, value] of uploads) if (value.expiresAt <= Date.now()) uploads.delete(key);
      const attachmentUrls = new Map<string, string>();
      for (const attachment of report.attachments) {
        const key = options ? `${options.issueId}:${createHash("sha256").update(JSON.stringify(attachment)).digest("hex")}` : undefined;
        let assetUrl = key ? uploads.get(key)?.assetUrl : undefined;
        if (!assetUrl) {
          assetUrl = await uploadAttachment(apiKey, attachment, request);
          if (key) {
            uploads.set(key, { assetUrl, expiresAt: Date.now() + uploadCacheTtlMs });
            while (uploads.size > uploadCacheLimit) uploads.delete(uploads.keys().next().value!);
          }
        }
        attachmentUrls.set(attachment.id, assetUrl);
      }

      stage = "create"; status = null;
      const description = formatDescription(report, attachmentUrls);
      if (description.length > LINEAR_DESCRIPTION_LIMIT) {
        throw new Error(
          `Linear description is too long (${description.length} characters; maximum is ${LINEAR_DESCRIPTION_LIMIT}).`,
        );
      }

      const response = await request("create", LINEAR_GRAPHQL_ENDPOINT, {
        method: "POST",
        signal: AbortSignal.timeout(12_000),
        redirect: "error",
        headers: {
          authorization: apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: ISSUE_CREATE_MUTATION,
          variables: {
            input: {
              ...(options ? { id: options.issueId } : {}),
              assigneeId: destination.assigneeId,
              description,
              labelIds: [destination.feedbackLabelId],
              priority: PRIORITY_BY_SEVERITY[report.severity],
              projectId: destination.projectId,
              stateId: destination.backlogStateId,
              teamId: destination.teamId,
              title: `[Feedback] ${report.title}`,
            },
          },
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as LinearResponse;
      const graphQLErrorMessage = linearErrorMessage(payload.errors);
      const issue = payload.data?.issueCreate?.issue;
      if (!response.ok || graphQLErrorMessage || !payload.data?.issueCreate?.success || !issue) {
        if (options) { const existing = await recover(); if (existing) return existing; }
        stage = "create"; status = response.status;
        throw new Error(graphQLErrorMessage ?? `Linear issue creation failed (${response.status}).`);
      }

      return {
        identifier: issue.identifier,
        url: issue.url,
      };
    } catch (error) {
      if (error !== null && typeof error === "object") {
        deliveryDiagnostics.set(error, { stage, status, reason: error instanceof UploadPreparationError ? error.reason : error instanceof Error && error.name === "TimeoutError" ? "timeout" : "failed" });
      }
      throw error;
    }
  };
}
