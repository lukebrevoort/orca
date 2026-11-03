import { z } from "zod";

export const feedbackAttachmentMaxBytes = 10 * 1024 * 1024;
export const feedbackAttachmentsMaxBytes = 20 * 1024 * 1024;
export const feedbackAttachmentMimeTypes = ["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm", "video/quicktime"] as const;
export const feedbackAttachmentSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(180).refine(value => !/[\x00-\x1f\x7f/\\]/.test(value), "Use a filename without paths or control characters."),
  mimeType: z.enum(feedbackAttachmentMimeTypes),
  dataUrl: z.string().max(4 * Math.ceil(feedbackAttachmentMaxBytes / 3) + 64),
  size: z.number().int().min(1).max(feedbackAttachmentMaxBytes),
}).strict();
export type FeedbackTicketAttachment = z.infer<typeof feedbackAttachmentSchema>;

// Only deliberately written feedback and explicitly selected media are sent.
export const feedbackTicketSubmissionSchema = z.object({
  id: z.uuid(),
  message: z.string().trim().min(1).max(10_000),
  platform: z.enum(["web", "ios"]),
  attachments: z.array(feedbackAttachmentSchema).max(3).optional(),
}).strict().refine(value => (value.attachments ?? []).reduce((sum, file) => sum + file.size, 0) <= feedbackAttachmentsMaxBytes, "Attachments must total at most 20 MiB.")
  .refine(value => new Set((value.attachments ?? []).map(file => file.id)).size === (value.attachments ?? []).length, "Attachment IDs must be unique.");
export type FeedbackTicketSubmission = z.infer<typeof feedbackTicketSubmissionSchema>;
export type FeedbackTicketReceipt = { identifier: string; url: string };
export type FeedbackTicketAvailability = { available: boolean };
