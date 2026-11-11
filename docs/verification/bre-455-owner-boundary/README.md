# BRE-455 browser notification owner boundary

Scope: BRE-453 D4, NOTIFY-01–04 and CORE-03. This API layer addresses the
unadopted-installation owner switch and supplies the synchronous witness needed
by the separately owned browser implementation. It does not establish whole-app,
native, OS display, provider delivery or live-mail acceptance.

Dependencies: [314](https://github.com/lukebrevoort/orca/pull/314),
[315](https://github.com/lukebrevoort/orca/pull/315),
[316](https://github.com/lukebrevoort/orca/pull/316),
[311](https://github.com/lukebrevoort/orca/pull/311),
[309](https://github.com/lukebrevoort/orca/pull/309).
Integration base: `062cb2ad81c15e5c5b9098a9f76295f4beb6b8dd` on
`integrate/BRE-455-browser-owner-base`. Preserve the dependency ancestry.

## Immutable runtime baseline

TEST-ONLY `21106209ef364c36272f0f926fed67bed32d79ca`, clean before/after.
Pinned Node 24.22.1 and Bun 1.3.14; frozen install succeeded (177 packages).
`bun test apps/api/src/auth/browser-owner-boundary.test.ts apps/api/src/auth/mail-oauth-security.test.ts`:
43 tests, **32 pass, 11 intended failures**, 204 expectations, 4.39 seconds.
Full local log: `/tmp/bre455-api-owner-red-21106209/focused-red.log`.
Receipt: [baseline-receipt.json](baseline-receipt.json).

Actual HTTP/SQLite failures: expected U + verified V fresh Pause returned 200,
creating a disabled V installation and V operation under U's local installation
ID; accounts returned 200. Other notification routes reached domain validation
or lookup instead of rejecting the changed owner. Fresh session lacked its
computed context header. Renewal/logout emitted only one cookie; completed new
identity callbacks emitted no verified pair for either provider. These are
runtime assertions, not missing-import or compilation failures.

Parent browser evidence is separate: A produced false editor success after a
real cookie switch. B held a repeated same-UUID final claim response across the
real cookie switch and observed a Chromium Notification constructor with U's
envelope. It did not prove OS display, later report status, or a later barrier.

## Published protocol

Shared constants in `packages/shared/src/browser-auth-context.ts`:

- `expectedUserIdHeaderName = "x-orca-expected-user-id"`
- `browserAuthContextCookieName = "orca_browser_auth_context"`
- `browserAuthContextHeaderName = "x-orca-browser-auth-context"`
- `browserAuthContextPattern = /^v1\.[A-Za-z0-9_-]{43}$/`

The optional owner header compares against immutable verified request auth
before body admission/domain connection. Absence preserves legacy behavior.
Malformed values return 400, mismatch 409 `session_owner_changed`, unauthenticated
requests 401; errors are private/no-store. Coverage includes all notification
reads/writes/operation reconciliation/claim/report, accounts initialization,
and auth/session. Preference behavior and JSON remain unchanged.

GET `/v1/auth/session` emits the independently computed context header **only**
for actual cookie authentication. The strict JSON schema stays unchanged.
The value is `v1.` plus a domain-separated HMAC-SHA256 over verified user/session
IDs under SESSION_SECRET. No raw JWT, session ID or user data is exposed. Incoming
markers cannot authenticate, choose ownership or control this header.

Fresh reads **never** set or repair a marker. A held U read cannot overwrite a
later V witness. Existing real renewal reissues both authentication and witness
cookies and retains the session ID/tag. Old unmarked sessions remain notification
unavailable until actual paired login/renewal; there is no bootstrap endpoint.

Production helpers exported by `apps/api/src/auth/browser-auth-context.ts`:

```ts
createBrowserAuthContext(session: Pick<SessionTokenPayload, "userId" | "sessionId">): string
buildBrowserSessionCookiePair(session: SessionTokenPayload & { token: string }, options?: SessionCookieOptions): [string, string]
setBrowserSessionCookies(c: Context, session: SessionTokenPayload & { token: string }): void
clearBrowserSessionCookies(c: Context): void
setPendingBrowserSessionCookies(c: Context, session: { token: string; expiresAt: Date }): void
```

Only server-verified real sessions may enter the verified helper. Fixture
login-other must call `setBrowserSessionCookies(c, realCreatedSession)`; no fake
marker flag or custom serializer. Helpers preserve separate Set-Cookie fields,
unrelated cookies, and the final pair when multiple writers run. Both cookies are
host-only Path=/, SameSite=Lax, production Secure with matching expiry. Session
remains HttpOnly; witness alone is readable and grants no authority.

Both providers' pending login pairs its actual pending session cookie with a
cleared witness. Promotion reissues the verified pair, returning-user login
issues its new pair, account-exists clears both. Bearer authentication does not
emit a context header or browser cookies. Cookie logout clears both even for
missing/invalid cookies; mixed Cookie+Authorization selection preserves the
existing cookie-authoritative logout contract. Bearer-only logout does not
mutate browser cookies. CSRF/signed token checks remain in force.

## Client obligation and honest limits

Web captures original `{owner, contextTag, installationId}` before permission,
token or network awaits. It validates a single accessible well-formed marker
synchronously when accepting the initial session response and **after the final
await immediately before** Notification construction or `location.assign` (and
again after `window.focus`). No await may intervene. Missing, duplicate,
malformed or inaccessible markers quietly make notification delivery unavailable.
An additional awaited preflight alone cannot close the last-await race.

This suppresses stale effects after supported application authentication-cookie
transitions become observable through the paired marker. Cookie-store updates
and JavaScript are not an atomic transaction. Arbitrary manual HttpOnly edits,
remote revocation without an observable signal, OS display, and physical-device
acceptance are outside this guarantee.

Relative `/v1` proxy/rewrite uses one browser-visible host. With a directly
separate API host, its host-only cookie is not readable by the app; notifications
must fail closed. Do not broaden Domain or CORS origins to compensate. No CORS
changes are needed for this same-host contract.

## Mobile registration audit

`PUT /v1/mobile/devices/:installationId` authenticates normally but has no
original-owner precondition on first registration. This is a source finding,
not a reproduced native/browser failure. This patch does not change `/v1/mobile/*`;
a reproduced case and root agreement are needed before extension.

## Verification and rollback

Focused API tests cover real HTTP/SQLite denial and positive controls, strict
legacy JSON/header absence, auth-source precedence, paired callbacks/renewal/
logout, final pair preservation and delayed fresh session consumption. No real
provider requests, credentials, local user data or mail-body access are needed.

Root owns independent correctness/security review, integrated final sequential
lint/typecheck/test/build at exact SHA, browser A/B plus held-session/navigation
acceptance, and merge. An early API draft is not final acceptance. Reverting
this narrow patch restores previous API behavior; the optional header leaves
legacy clients compatible and there is no schema migration to roll back.

Checkpoint `ee2962c40414d22b3035471bd1c7cdc59fdd2a38`:
304 auth/notification tests across 27 files passed (1,474 expectations, 21.64s).
Actual shared tsc and the HTTP/SQLite proof passed. Actual API tsc **failed**
TS2322 in a test's inferred heterogeneous request-header array; the correction
uses real `Headers` instances. The receipt retains this failure; this checkpoint
is not claimed type-green. [Runtime proof](http-proof-ee2962c4.json),
[checkpoint receipt](focused-ee2962c4-receipt.json).

## Final root review checkpoint

The published API checkpoint `1549608c194ec40c7ecfb5060242e0b41520a8bc`
passed **309 focused tests / 1,514 expectations**, actual API/shared TypeScript
checks, and the synthetic HTTP/SQLite proof. Retained receipts and the openable
proof are in [final-review-checkpoint](final-review-checkpoint/).
The proof records mismatched-owner 409 responses with unchanged installation
and operation tables; a same-owner command succeeds. A held fresh-session read
sets no cookies, while a real replacement login and logout each emit the pair.
It serializes no tokens, raw session IDs, secrets or witness values.

Hosted Unit Tests run `43021222685`, job `130524621958`, exposed two existing
real logout-route assertions that still expected only the session cookie.
[The failure excerpt](final-review-checkpoint/hosted-1549608c-logout-excerpt.log)
is retained. The test-only correction at
`edab9f6a702be9b2fb2f8477af4e0fc895993523` asserts both cleared cookies through
`getSetCookie()`, preserving the original revocation, subsequent 401, Origin,
method and database assertions. The same real route suite passed **8/8 tests,
53 expectations** at that clean head; [receipt](final-review-checkpoint/logout-edab9f6a.json)
and [log](final-review-checkpoint/logout-edab9f6a.log) are retained. API production
bytes are unchanged from `1549608c`.

Fresh independent source correctness review approved the protocol and this
assertion correction. Independent security review found no authorization or
credential flaw; its blocking verification finding was the two obsolete logout
assertions, now corrected. These reviews did not execute browser, native or OS
acceptance. Final frozen-head full sequential lint/typecheck/tests/build and the
integrated browser checks remain separate gates. The final gate receipt will
identify its own exact SHA; historical receipts above are not relabeled.

To reproduce the synthetic proof from a clean checkout with frozen dependencies:

```sh
bun apps/api/scripts/browser-owner-boundary-proof.ts /tmp/new-browser-owner-proof.json
```

The output path must be new. Run the relevant workspace gates sequentially under
the shared resource guard. This proof uses a temporary SQLite database and
in-process authenticated HTTP requests, with no live provider or OS delivery.
[SHA-256 checksums](final-review-checkpoint/sha256.json) cover the retained files.
