import { z } from "zod";

const source = z.object({ messageId: z.string().min(1), threadId: z.string().min(1) }).strict();
const item = z.object({
  source, reasons: z.array(z.string()).min(1), title: z.string(), snippet: z.string(),
  sender: z.string(), receivedAt: z.iso.datetime(),
}).strict();
const count = z.number().int().nonnegative();
export const summaryResponseSchema = z.object({
  accountId: z.string().min(1),
  needsYou: z.array(item).max(20),
  waitingOn: z.array(item.extend({ days: count })).max(20),
  codes: z.object({ available: z.literal(false), items: z.array(z.never()).length(0) }).strict(),
  draftedReplies: z.object({ available: z.literal(false), items: z.array(z.never()).length(0) }).strict(),
  routine: z.object({ count }).strict(),
  counts: z.object({ needsYou: count.max(20), waitingOn: count.max(20), codes: z.literal(0), draftedReplies: z.literal(0), routine: count }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.counts.needsYou !== value.needsYou.length || value.counts.waitingOn !== value.waitingOn.length || value.counts.routine !== value.routine.count)
    ctx.addIssue({ code: "custom", message: "Tile counts must match their contents" });
});
export type SummaryResponse = z.infer<typeof summaryResponseSchema>;
