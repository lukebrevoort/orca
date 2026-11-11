import { z } from "zod";

export const notificationChannelSchema = z.enum(["apns", "open_app"]);
export const notificationPermissionSchema = z.enum(["granted", "denied", "default", "unavailable"]);
const accountIds = z.array(z.string().trim().min(1).max(256)).max(100)
  .refine(ids => new Set(ids).size === ids.length, "Account IDs must be unique");
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const installationId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);

/** Explicit adoption/settings command. Token registration and OS permission are separate capabilities. */
export const importantNotificationCommandSchema = z.object({
  channel: notificationChannelSchema,
  policyVersion: z.literal(1),
  enabled: z.boolean(),
  accountIds,
  permission: notificationPermissionSchema,
  expectedRevision: revision,
  operationId: z.uuid(),
}).strict().refine(value => !value.enabled || value.accountIds.length > 0,
  "Choose at least one account before enabling notifications");

export const importantNotificationInstallationSchema = z.object({
  installationId,
  channel: notificationChannelSchema,
  revision,
  policy: z.object({
    version: z.literal(1),
    kind: z.literal("important_only"),
    enabled: z.boolean(),
    accountIds,
  }).strict().nullable(),
  permission: z.enum(["unknown", "granted", "denied", "default", "unavailable"]),
  previousSelection: z.object({ inbox: z.boolean(), spaceIds: z.array(z.string()).max(100) }).strict().nullable(),
  delivery: z.object({
    available: z.boolean(),
    scope: notificationChannelSchema,
    reason: z.enum(["not_adopted", "disabled", "permission_required", "registration_required", "server_unavailable", "no_accounts"]).nullable(),
  }).strict(),
  cooldownSeconds: z.literal(900),
}).strict();

/** A retry returns the original receipt alongside CURRENT settings; it never reapplies an old command. */
export const importantNotificationOperationSchema = z.object({
  operationId: z.uuid(),
  status: z.enum(["current", "superseded"]),
  appliedRevision: revision,
  current: importantNotificationInstallationSchema,
}).strict();

export const importantNotificationClaimSchema = z.object({
  channel: z.literal("open_app"),
  expectedRevision: revision,
  operationId: z.uuid(),
  permission: z.literal("granted"),
}).strict();

export const importantNotificationEnvelopeSchema = z.object({
  id: z.string().min(1).max(128),
  accountId: z.string().min(1).max(256),
  threadId: z.string().min(1),
  title: z.string().max(160),
  subtitle: z.string().max(240),
  body: z.string().max(480),
  tag: z.string().min(1).max(128),
}).strict();

/** Eligibility/claim is not proof that the operating system displayed an alert. */
export const importantNotificationClaimResponseSchema = z.object({
  operationId: z.uuid(),
  installationId,
  policyRevision: revision,
  scope: z.literal("open_app"),
  notifications: z.array(importantNotificationEnvelopeSchema).max(20),
}).strict();

export const importantNotificationReportSchema = z.object({
  operationId: z.uuid(),
  notificationIds: z.array(z.string().min(1).max(128)).max(20)
    .refine(ids => new Set(ids).size === ids.length, "Notification IDs must be unique"),
  outcome: z.enum(["constructed", "failed"]),
}).strict();

export type NotificationChannel = z.infer<typeof notificationChannelSchema>;
export type NotificationPermission = z.infer<typeof notificationPermissionSchema>;
export type ImportantNotificationCommand = z.infer<typeof importantNotificationCommandSchema>;
export type ImportantNotificationInstallation = z.infer<typeof importantNotificationInstallationSchema>;
export type ImportantNotificationOperation = z.infer<typeof importantNotificationOperationSchema>;
export type ImportantNotificationClaim = z.infer<typeof importantNotificationClaimSchema>;
export type ImportantNotificationEnvelope = z.infer<typeof importantNotificationEnvelopeSchema>;
export type ImportantNotificationClaimResponse = z.infer<typeof importantNotificationClaimResponseSchema>;
export type ImportantNotificationReport = z.infer<typeof importantNotificationReportSchema>;
