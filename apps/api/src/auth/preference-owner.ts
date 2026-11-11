import { createOwnerPrecondition } from "./session-owner.ts";

/** Preserve the existing optional preference-owner protocol and error copy. */
export const requirePreferenceOwner = createOwnerPrecondition({
  invalid: "Invalid preference owner precondition",
  changed: "The signed-in account changed. Reload preferences before saving.",
});
