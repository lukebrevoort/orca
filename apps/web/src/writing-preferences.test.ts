import { expect, test } from "bun:test";
import { markdownToEditorHtml } from "./compose-workspace";
import { defaultWritingPreferences, initializeWritingDraft, resolveWritingReplyAction, serializeWritingBody, type WritingPreferenceState } from "./writing-preferences";

const ready: WritingPreferenceState = { accountId: "account-a", status: "ready", preferences: { signature: "Best,\nAlex", composeFormat: "rich", replyBehavior: "reply_all" } };
const fresh = { isNew: true, isHydrated: true, hasEdits: false };
const empty = { accountId: "account-a", body: "" };

test("signature and format initialize exactly once, including after signature deletion and JSON recovery", () => {
  const initialized = initializeWritingDraft(empty, ready, fresh);
  expect(initialized).toMatchObject({ body: "\n\nBest,\nAlex", composeFormat: "rich", writingPreferencesApplied: true });
  const restored = JSON.parse(JSON.stringify({ ...initialized, body: "My words" }));
  expect(initializeWritingDraft(restored, { ...ready, preferences: { ...ready.preferences, signature: "Changed" } }, fresh)).toBe(restored);
});

test("no preference changes before hydration or after any edit, even typing then deleting", () => {
  for (const lifecycle of [{ ...fresh, isHydrated: false }, { ...fresh, hasEdits: true }, { ...fresh, isNew: false }]) {
    expect(initializeWritingDraft(empty, ready, lifecycle)).toBe(empty);
    const existing = { ...empty, body: "Recovered **writing**", composeFormat: "rich" as const };
    expect(initializeWritingDraft(existing, ready, lifecycle)).toBe(existing);
  }
});

test("loading or another account never initializes a draft", () => {
  expect(initializeWritingDraft(empty, { ...ready, status: "loading" }, fresh)).toBe(empty);
  expect(initializeWritingDraft(empty, { ...ready, accountId: "account-b" }, fresh)).toBe(empty);
  expect(initializeWritingDraft(empty, ready, fresh).body).toContain("Alex");
});

test("unavailable preferences use safe plain defaults once without a stale signature", () => {
  const initialized = initializeWritingDraft(empty, { ...ready, status: "unavailable" }, fresh);
  expect(initialized).toMatchObject({ body: "", composeFormat: "plain", writingPreferencesApplied: true });
  expect(initializeWritingDraft(initialized, ready, fresh)).toBe(initialized);
});

test("signature is before forwarded seed content; empty signatures add nothing", () => {
  const forward = { ...empty, body: "Forwarded message\nOriginal words" };
  expect(initializeWritingDraft(forward, ready, fresh).body).toBe("\n\nBest,\nAlex\n\nForwarded message\nOriginal words");
  expect(initializeWritingDraft(forward, { ...ready, preferences: defaultWritingPreferences }, fresh).body).toBe(forward.body);
});

test("only primary reply uses the preference, and only for its authorized account", () => {
  expect(resolveWritingReplyAction("primary", "account-a", ready)).toBe("reply_all");
  for (const action of ["reply", "reply_all", "forward"] as const) expect(resolveWritingReplyAction(action, "account-a", ready)).toBe(action);
  expect(resolveWritingReplyAction("primary", "account-b", ready)).toBe("reply");
  expect(resolveWritingReplyAction("primary", "account-a", { ...ready, status: "unavailable" })).toBe("reply");
});

test("plain serialization is literal; rich serialization uses escaped existing renderer; legacy stays rich", () => {
  const body = "**Hello**\n<script>alert(1)</script>";
  expect(serializeWritingBody(body, "plain", markdownToEditorHtml)).toEqual({ text: body, html: null });
  for (const format of ["rich", undefined] as const) {
    const rich = serializeWritingBody(body, format, markdownToEditorHtml);
    expect(rich.text).toBe(body);
    expect(rich.html).toContain("<strong>Hello</strong>");
    expect(rich.html).toContain("&lt;script&gt;");
    expect(rich.html).not.toContain("<script>");
  }
  expect(serializeWritingBody("", "rich", markdownToEditorHtml).html).toBeNull();
});
