import { test, expect } from "bun:test";
import { gmailArrivalEvidence } from "./provenance.ts";
import type { GmailMessage } from "../providers/gmail/types.ts";
const now = Date.parse("2026-11-11T09:00:00Z");
export function smtpMessage(id = "incoming", options: { timestamp?: number; labels?: string[]; address?: string } = {}): GmailMessage {
  const timestamp = options.timestamp ?? now, address = options.address ?? "u@example.com";
  return { id, threadId: `thread-${id}`, internalDate: String(timestamp), labelIds: options.labels ?? ["UNREAD"], payload: { headers: [
    { name: "Delivered-To", value: address }, { name: "Received", value: "by 2002:a05:1234 with SMTP id abc; " + new Date(timestamp).toUTCString() },
    { name: "Received", value: `from mail.sender.example (mail.sender.example [192.0.2.1]) by mx.google.com with ESMTPS id abc for <${address}>; ${new Date(timestamp).toUTCString()}` },
    { name: "From", value: "Receipt Bot <receipt@example.net>" }, { name: "Subject", value: "Payment receipt" },
  ] } };
}
test("BRE-455 SMTP metadata is exact-account bounded evidence independent of Inbox", () => {
  expect(gmailArrivalEvidence(smtpMessage(), "u@example.com", now)).toEqual({ evidence: "gmail_smtp_metadata", reason: "provider_observed_primary_smtp", receivedAt: now });
  for (const labels of [["UNREAD", "SENT"], ["UNREAD", "DRAFT"]]) expect(gmailArrivalEvidence(smtpMessage("sent", { labels }), "u@example.com", now).evidence).toBe("unknown");
  expect(gmailArrivalEvidence(smtpMessage("other", { address: "alias@example.com" }), "u@example.com", now).evidence).toBe("unknown");
  expect(gmailArrivalEvidence(smtpMessage("old", { timestamp: now - 301000 }), "u@example.com", now).reason).toBe("old_receiving_time");
  expect(gmailArrivalEvidence(smtpMessage("future", { timestamp: now + 61000 }), "u@example.com", now).reason).toBe("future_receiving_time");
});
test("BRE-455 original ordered duplicate headers cannot override earlier delivery evidence", () => {
  const contradictory = smtpMessage();
  contradictory.payload!.headers!.unshift({ name: "Received", value: `from attacker by attacker.example with ESMTP for <u@example.com>; ${new Date(now).toUTCString()}` });
  expect(gmailArrivalEvidence(contradictory, "u@example.com", now).evidence).toBe("unknown");
  const recipient = smtpMessage(); recipient.payload!.headers!.push({ name: "Delivered-To", value: "other@example.com" });
  expect(gmailArrivalEvidence(recipient, "u@example.com", now).evidence).toBe("unknown");
  const spoofHost = smtpMessage(); spoofHost.payload!.headers![2]!.value = spoofHost.payload!.headers![2]!.value.replace("mx.google.com", "mx.google.com.attacker.example");
  expect(gmailArrivalEvidence(spoofHost, "u@example.com", now).evidence).toBe("unknown");
  const wrongTime = smtpMessage(); wrongTime.internalDate = String(now - 121000);
  expect(gmailArrivalEvidence(wrongTime, "u@example.com", now).reason).toBe("contradictory_receiving_time");
  const noTrace = smtpMessage(); noTrace.payload!.headers = [{ name: "From", value: "alias@example.com" }];
  expect(gmailArrivalEvidence(noTrace, "u@example.com", now).evidence).toBe("unknown");
  const own = smtpMessage(); own.payload!.headers![3]!.value = "u@example.com";
  expect(gmailArrivalEvidence(own, "u@example.com", now).reason).toBe("own_primary_sender");
});
test("BRE-455 imported old date, missing invalid time, duplicated From and trailing fake headers remain unknown", () => {
  for (const internalDate of [undefined, "", "nan", "-1", String(now - 86400000)]) {
    const value = smtpMessage(); value.internalDate = internalDate;
    expect(gmailArrivalEvidence(value, "u@example.com", now).evidence).toBe("unknown");
  }
  const duplicate = smtpMessage(); duplicate.payload!.headers!.push({ name: "From", value: "u@example.com" });
  expect(gmailArrivalEvidence(duplicate, "u@example.com", now).reason).toBe("ambiguous_sender");
  const laterFake = smtpMessage();
  laterFake.payload!.headers![2]!.value = laterFake.payload!.headers![2]!.value.replace("u@example.com", "other@example.com");
  laterFake.payload!.headers!.push(smtpMessage().payload!.headers![2]!);
  expect(gmailArrivalEvidence(laterFake, "u@example.com", now).evidence).toBe("unknown");
  const wrongOrder = smtpMessage(); wrongOrder.payload!.headers!.push(wrongOrder.payload!.headers!.shift()!);
  expect(gmailArrivalEvidence(wrongOrder, "u@example.com", now).reason).toBe("invalid_envelope_order");
});
