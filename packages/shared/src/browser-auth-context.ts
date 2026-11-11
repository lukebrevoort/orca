/** Optional original-owner request precondition; never an authentication credential. */
export const expectedUserIdHeaderName = "x-orca-expected-user-id";
/** Noncredential witness, scoped to the browser-visible API host. */
export const browserAuthContextCookieName = "orca_browser_auth_context";
/** Computed from the verified cookie session; never echoed from a request marker. */
export const browserAuthContextHeaderName = "x-orca-browser-auth-context";
export const browserAuthContextPattern = /^v1\.[A-Za-z0-9_-]{43}$/;
