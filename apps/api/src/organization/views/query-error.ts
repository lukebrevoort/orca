// Pure predicate readers must not initialize the View mutation/authority graph
// just to share an error. module.ts re-exports this same constructor for callers.
export class OrganizationViewQueryError extends Error {
  readonly code = "invalid_cursor" as const;
  constructor(message: string) { super(message); this.name = "OrganizationViewQueryError"; }
}
