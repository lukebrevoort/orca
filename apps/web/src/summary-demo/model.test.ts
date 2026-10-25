import { expect, test } from "bun:test";
import { createFixtures } from "./fixtures";
import { activeItems, canApprove, countdown, counts, isExpired, notificationLines, pluralize, transition } from "./model";
test("active counts exclude handled, approved, stopped and expired while retaining cards", () => {
  let state = createFixtures(0);
  state = transition(state, "work", { type: "handle", id: "work-attention" });
  state = transition(state, "work", { type: "approve", id: "work-reply" });
  state = transition(state, "work", { type: "stop", id: "work-waiting" });
  expect(counts(state.work, 120000)).toEqual([0, 0, 0, 0]);
  expect(state.work.attention).toHaveLength(1);
  expect(state.work.replies).toHaveLength(1);
  expect(state.work.waiting).toHaveLength(1);
  expect(state.work.codes).toHaveLength(1);
  expect(activeItems(state.work, 120000).codes).toEqual([]);
  expect(counts(state.personal, 0)).toEqual([1, 1, 1, 1]);
});
test("follow-up drafts belong to Waiting on and never increase the Drafted replies tile", () => {
  const original = createFixtures(0);
  const next = transition(original, "work", { type: "follow-up", id: "work-waiting" });
  expect(next.work.waiting[0]!.draft?.status).toBe("Draft");
  expect(counts(next.work, 0)[1]).toBe(1);
  expect(transition(next, "work", { type: "follow-up", id: "work-waiting" })).toEqual(next);
  expect(original.work.waiting[0]!.draft).toBeUndefined();
  expect(next.personal).toBe(original.personal);
});
test("edits and approval are local, immutable and whitespace-safe", () => {
  const original = createFixtures(0);
  let next = transition(original, "personal", { type: "edit", id: "personal-reply", body: "  \n " });
  expect(next.personal.replies[0]!.status).toBe("Edited");
  expect(canApprove(next.personal.replies[0]!)).toBe(false);
  next = transition(next, "personal", { type: "approve", id: "personal-reply" });
  expect(next.personal.replies[0]!.status).toBe("Edited");
  next = transition(next, "personal", { type: "edit", id: "personal-reply", body: "Yes, thanks." });
  next = transition(next, "personal", { type: "approve", id: "personal-reply" });
  expect(next.personal.replies[0]!.status).toBe("Approved");
  expect(transition(next, "personal", { type: "edit", id: "personal-reply", body: "changed" })).toEqual(next);
  expect(original.personal.replies[0]!.status).toBe("Draft");
});
test("stopped tracking cannot create or edit follow-up drafts", () => {
  let state = createFixtures(0);
  state = transition(state, "work", { type: "stop", id: "work-waiting" });
  expect(transition(state, "work", { type: "follow-up", id: "work-waiting" })).toEqual(state);
});
test("follow-up drafts can be edited and approved without changing the fixture reply count", () => {
  let state = transition(createFixtures(0), "work", { type: "follow-up", id: "work-waiting" });
  state = transition(state, "work", { type: "edit", id: "work-waiting-draft", body: "Any news?" });
  state = transition(state, "work", { type: "approve", id: "work-waiting-draft" });
  expect(state.work.waiting[0]!.draft?.status).toBe("Approved");
  expect(counts(state.work, 0)).toEqual([1, 1, 1, 1]);
});
test("expiry includes the exact boundary and countdown rounds up", () => {
  const code = createFixtures(0).work.codes[0]!;
  expect(countdown(code, 0)).toBe("2:00 remaining");
  expect(countdown(code, 119001)).toBe("0:01 remaining");
  expect(isExpired(code, 120000)).toBe(true);
  expect(countdown(code, 120000)).toBe("Expired");
  expect(countdown(code, 130000)).toBe("Expired");
});
test("days pluralize and notifications contain categories and counts only", () => {
  expect(pluralize(1, "day")).toBe("1 day");
  expect(pluralize(2, "day")).toBe("2 days");
  expect(pluralize(0, "day")).toBe("0 days");
  expect(notificationLines(createFixtures(0).work, 0)).toEqual(["Needs you: 1", "Drafted replies: 1", "Waiting on: 1", "Codes: 1"]);
});
