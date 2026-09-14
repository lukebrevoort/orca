import { laneSchema } from "./organization-lanes.ts";
import { expect, test } from "bun:test";
import { destinationCreateSchema, destinationRoutingChangeSchema, destinationUpdateSchema } from "./mail-destinations.ts";
test("destination contracts normalize names and strictly guard writes", () => {
    expect(destinationCreateSchema.parse({ expectedRevision: 1, name: "  Clients  " }).name).toBe("Clients");
    expect(destinationCreateSchema.safeParse({ expectedRevision: 0, name: "Clients" }).success).toBe(false);
    expect(destinationCreateSchema.safeParse({ expectedRevision: 1, name: "  " }).success).toBe(false);
    expect(destinationUpdateSchema.safeParse({ expectedRevision: 1 }).success).toBe(false);
    expect(destinationRoutingChangeSchema.parse({ expectedRevision: 2, target: { scope: "sender", address: "MAYA@example.com" }, destinationId: null }).target).toEqual({ scope: "sender", address: "maya@example.com" });
    expect(destinationRoutingChangeSchema.safeParse({ expectedRevision: 1, target: { scope: "account" }, destinationId: "" }).success).toBe(false);
});

test("colors accept validated hex and historic lane snapshots receive a neutral default", () => {
    expect(destinationCreateSchema.parse({ expectedRevision: 1, name: "Clients", color: "#ABC123" }).color).toBe("#ABC123");
    for (const color of ["red", "#abc", "#12345678", "url(evil)", null]) {
        expect(destinationUpdateSchema.safeParse({ expectedRevision: 1, color }).success).toBe(false);
    }
    expect(destinationUpdateSchema.parse({ expectedRevision: 1, color: "#648ac4" }).color).toBe("#648ac4");
    expect(laneSchema.parse({ id: "old", name: "Personal desk", position: 0, defaultPolicyId: "p", retiredAt: null, revision: 1 }).color).toBe("#70867d");
});
