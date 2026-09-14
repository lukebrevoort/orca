import { z } from "zod";

export const notificationChoiceSchema = z.enum(["notify", "quiet"]);
export const notificationSenderSchema = z.object({
  address: z.string().trim().toLowerCase().email().max(254),
  choice: notificationChoiceSchema,
}).strict();
const choices = z.object({
  defaultChoice: notificationChoiceSchema,
  senders: z.array(notificationSenderSchema).max(1000),
}).strict();
function uniqueSenders(value: { senders: { address: string }[] }) {
  return new Set(value.senders.map(sender => sender.address)).size === value.senders.length;
}
export const updateAttentionPreferencesSchema = choices.extend({ expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1) })
  .refine(uniqueSenders, { message: "This sender is already on your list.", path: ["senders"] });
export const attentionPreferencesSchema = choices.extend({
  accountId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  delivery: z.literal("proposal_only"),
}).refine(uniqueSenders, { message: "Duplicate sender preferences" });
export type NotificationChoice = z.infer<typeof notificationChoiceSchema>;
export type AttentionPreferences = z.infer<typeof attentionPreferencesSchema>;
export type UpdateAttentionPreferences = z.infer<typeof updateAttentionPreferencesSchema>;
