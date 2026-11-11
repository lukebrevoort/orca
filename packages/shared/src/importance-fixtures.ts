import type { ImportanceResolution } from "./importance.ts";

export const importanceResolutionFixtures: readonly ImportanceResolution[] = [
  { effective: "important", source: "participants", conversation: { choice: null, revision: 0 }, inherited: "important",
    participantCounts: { important: 1, notImportant: 0, unreviewed: 1, total: 2 },
    preferences: [{ address: "robot@example.com", choice: "important", revision: 1 }], preferencesTruncated: false, accountRevision: 5 },
  { effective: "not_important", source: "conversation", conversation: { choice: "not_important", revision: 3 }, inherited: "important",
    participantCounts: { important: 1, notImportant: 0, unreviewed: 0, total: 1 },
    preferences: [{ address: "person@example.com", choice: "important", revision: 2 }], preferencesTruncated: false, accountRevision: 8 },
  { effective: "unreviewed", source: "unreviewed", conversation: { choice: null, revision: 4 }, inherited: "unreviewed",
    participantCounts: { important: 0, notImportant: 0, unreviewed: 0, total: 0 }, preferences: [], preferencesTruncated: false, accountRevision: 9 },
];
