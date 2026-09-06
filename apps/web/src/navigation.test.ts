import { describe, expect, test } from "bun:test";
import { organizationViewsFixture, type Collection } from "@orca/shared";
import {
  createSidebarNavigationProjection,
  desktopDestinationFromLocation,
  desktopDestinationHref,
  desktopDestinationUrl,
  parseDesktopDestination,
  readSpacePreferences,
  spacePreferencesKey,
  writeSpacePreferences,
} from "./navigation";

const collections: Collection[] = [
  { id: "space-two", accountId: "account", name: "Second", color: "#222222", position: 1, threadIds: ["thread-2"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "space-one", accountId: "account", name: "First", color: "#111111", position: 0, threadIds: ["thread-1", "thread-3"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
];

describe("shared desktop navigation contract", () => {
  test("parses one destination grammar and serializes stable production and preview URLs", () => {
    expect(parseDesktopDestination("space:space-one")).toBe("space:space-one");
    expect(parseDesktopDestination("view:view-one")).toBe("view:view-one");
    expect(parseDesktopDestination("space:")).toBeNull();
    expect(parseDesktopDestination("unknown")).toBeNull();
    expect(desktopDestinationFromLocation({ pathname: "/settings/integrations/gmail", search: "?destination=space:ignored" } as Location)).toBe("settings");
    expect(desktopDestinationFromLocation({ pathname: "/", search: "?destination=space%3Aspace-one" } as Location)).toBe("space:space-one");
    expect(desktopDestinationHref("space:space-one", "/settings")).toBe("/?destination=space%3Aspace-one");
    expect(desktopDestinationHref("space:space-one", "/dev/settings")).toBe("/dev/inbox?destination=space%3Aspace-one");
    expect(desktopDestinationHref("view:view-one", "/settings")).toBe("/?destination=view%3Aview-one");
    expect(desktopDestinationUrl("http://localhost:5173/dev/inbox?q=maya&thread=thread-1&compose=1", "focus")).toBe("/dev/inbox?q=maya&destination=focus");
  });

  test("projects names, order, hidden state, counts, active destination, and offline health once for every shell", () => {
    const projection = createSidebarNavigationProjection({
      account: { displayName: "Maya Chen", email: "maya@example.com", accountCount: 2 },
      active: "space:space-one",
      collections,
      counts: { focus: 4, signals: 3, quiet: 2, later: 1 },
      draftCount: 5,
      hidden: ["signals", "space-two"],
      inboxCount: 12,
      labels: { focus: "Deep focus", "space-one": "Launch room" },
      online: false,
      order: ["space-one", "quiet", "focus", "signals", "later", "space-two"],
      syncing: true,
    });

    expect(projection.active).toBe("space:space-one");
    expect(projection.account.health).toBe("offline");
    expect(projection.account.detail).toContain("cached mail and drafts");
    expect(projection.inboxCount).toBe(12);
    expect(projection.draftCount).toBe(5);
    expect(projection.spaces.map((space) => [space.id, space.label, space.count, space.hidden])).toEqual([
      ["space-one", "Launch room", 2, false],
      ["quiet", "Quiet", 2, false],
      ["focus", "Deep focus", 4, false],
      ["signals", "Signals", 3, true],
      ["later", "Later", 1, false],
      ["space-two", "Second", 1, true],
    ]);
  });

  test("round-trips account-scoped space preferences through the shared storage seam", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const preferences = { revision: 1 as const, order: ["quiet", "focus"], hidden: ["signals"], labels: { quiet: "Low tide" } };
    writeSpacePreferences("account", preferences, storage);
    expect(values.has(spacePreferencesKey("account"))).toBe(true);
    expect(readSpacePreferences("account", storage)).toEqual(preferences);
  });

  test("projects saved Views after locally managed spaces with their durable destination identity", () => {
    const projection = createSidebarNavigationProjection({
      account: { displayName: "Maya", email: "maya@example.com", accountCount: 1 },
      active: `view:${organizationViewsFixture[0]!.id}`,
      collections,
      views: organizationViewsFixture,
      online: true,
    });
    const projectedViews = projection.spaces.filter((space) => space.kind === "view");
    expect(projectedViews.map((space) => space.label)).toEqual(organizationViewsFixture.map((view) => view.name));
    expect(projectedViews.map((space) => space.hidden)).toEqual([false, false, false]);
    expect(projectedViews.map((space) => `view:${space.id}`)).toContain(projection.active);
  });
});
