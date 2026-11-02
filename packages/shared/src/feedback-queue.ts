import { z } from "zod";

// Routes are surface names, never message IDs, search strings or captured mail.
export const feedbackQueueSubmissionSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(10_000),
  kind: z.enum(["bug", "idea", "question", "other"]),
  platform: z.enum(["web", "ios"]),
  route: z.enum(["/", "/settings", "/inbox", "/feedback", "/organization", "/search", "/compose"]),
}).strict();
export type FeedbackQueueSubmission = z.infer<typeof feedbackQueueSubmissionSchema>;
export type FeedbackQueueItem = FeedbackQueueSubmission & {
  status: "queued" | "delivered";
  createdAt: string;
  identifier: string | null;
  url: string | null;
  deliveryError: string | null;
};
export type FeedbackQueueResponse = { items: FeedbackQueueItem[]; deliveryAvailable: boolean };
export type FeedbackQueueSubmissionResponse = { item: FeedbackQueueItem; deliveryAvailable: boolean };
