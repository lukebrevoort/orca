# Native mobile authentication

The native client uses OAuth-style authorization-code exchange with PKCE S256. It never receives Gmail or Outlook provider credentials.

1. `POST /v1/mobile/auth/start` with `{ codeChallenge, state }` returns `{ authorizationUrl, expiresAt }`.
2. Open `authorizationUrl` in the system authentication browser. Orca reuses its normal Gmail/Outlook login and displays the signed-in account before a deliberate **Connect this iPhone** confirmation.
3. Confirmation returns to the fixed callback `orca://auth?code=...&state=...`. The short-lived code is single-use and no reusable credential appears in the URL.
4. `POST /v1/mobile/auth/exchange` with `{ code, codeVerifier }` returns `{ accessToken, expiresAt }`.
5. Send the opaque access token as `Authorization: Bearer <accessToken>`. Only its SHA-256 hash is stored.
6. `DELETE /v1/mobile/auth/session` with that bearer token revokes only the mobile session; the desktop cookie session remains valid.

The browser consent internals use `GET /authorize` to bind the request to the authenticated web session with an HttpOnly SameSite cookie, then same-origin `POST /grant` with a one-time CSRF token. They are not native-client APIs.

Integration fixtures may call `createMobileSession(db, userId, now)` from `store.ts` to mint the same opaque, hashed credential used by production exchange. There is intentionally no development bypass route.

`/start`, `/grant`, and `/exchange` admit at most a small JSON body. `/start` applies a per-client limit using the direct transport peer address from `@hono/node-server`, retains a separate high process-wide overload ceiling, and refuses new work when 10,000 live pending requests exist. Forwarding headers are ignored by default. In a fixed, controlled proxy topology, set `MOBILE_AUTH_TRUSTED_PROXY_HOPS` from `1` through `5`; Orca then selects the client address from the right of a strictly validated `X-Forwarded-For` chain, so attacker-supplied leftmost entries cannot select a rate-limit bucket. For Railway's single controlled edge hop, use `MOBILE_AUTH_TRUSTED_PROXY_HOPS=1` only when the API origin cannot be reached directly and the edge overwrites or appends the actual source address. Do not enable it for a variable proxy chain. Admission also prunes expired authorization records and mobile sessions beyond the seven-day operational retention window.
