import { expect, test } from "bun:test";
import { OrganizationViewQueryError as PublicQueryError } from "./module.ts";
import { OrganizationViewQueryError } from "./query-error.ts";
import { threadMatchPredicate } from "./thread-predicate.ts";

test("lightweight predicate error preserves the public constructor and authorization rejection", () => {
  expect(PublicQueryError).toBe(OrganizationViewQueryError);
  expect(new OrganizationViewQueryError("invalid").code).toBe("invalid_cursor");
  expect(() => threadMatchPredicate({ workspaceId: "workspace", accountIds: ["owned"] }, {
    definition: { revision: 1, accountIds: ["foreign"] },
  })).toThrow(PublicQueryError);
});
