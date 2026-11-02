import { z } from "zod";

// Only deliberately written feedback is sent, never mail, screenshots or routes.
export const feedbackTicketSubmissionSchema = z.object({
  id: z.uuid(),
  message: z.string().trim().min(1).max(10_000),
  platform: z.enum(["web", "ios"]),
}).strict();
export type FeedbackTicketSubmission = z.infer<typeof feedbackTicketSubmissionSchema>;
export type FeedbackTicketReceipt = { identifier: string; url: string };
export type FeedbackTicketAvailability = { available: boolean };
