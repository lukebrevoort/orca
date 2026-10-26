import type { Account, AccountId, DemoState } from "./model";
function account(id: AccountId, now: number): Account {
  const work = id === "work";
  return {
    attention: [{ id: `${id}-attention`, subject: work ? "Review the launch plan" : "Choose a weekend walk", person: work ? "Maya Chen" : "Sam Rivera", reason: work ? "Your review is requested before Thursday." : "A friend asked for your preference.", handled: false }],
    replies: [{ id: `${id}-reply`, subject: work ? "Design review notes" : "Dinner on Friday", person: work ? "Alex Morgan" : "Jordan Lee", body: work ? "Thanks for the notes. I will review them this afternoon." : "Friday works for me. How about seven?", status: "Draft" }],
    waiting: [{ id: `${id}-waiting`, subject: work ? "Budget confirmation" : "Cabin booking", person: work ? "Taylor Brooks" : "Casey Park", days: work ? 1 : 2, stopped: false }],
    codes: [{ id: `${id}-code`, subject: work ? "Workspace sign-in" : "Library sign-in", person: work ? "Demo Workspace" : "Demo Library", value: work ? "482631" : "915204", expiresAt: now + (work ? 120000 : 180000) }],
    routine: [{ id: `${id}-routine`, subject: work ? "Weekly activity digest" : "Monthly library news", person: work ? "Demo Updates" : "Demo Reading" }],
  };
}
export function createFixtures(now: number): DemoState { return { work: account("work", now), personal: account("personal", now) }; }
