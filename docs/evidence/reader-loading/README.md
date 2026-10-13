# Reader loading copy

Base: `0e6805131a9c8386107bf70f598e2b61b0cf6a0b`.

Synthetic reproduction: build web, run `apps/api/scripts/compose-fixture.ts`, log in with `/__fixture/login`, and navigate to `/?thread=unknown-thread&accountId=first` while holding that thread's detail request pending. The unresolved deep link has no inbox preview. Before: “Opening conversation · 1 messages” and “(no subject)”. After: “Opening conversation” and “Loading conversation”. No count or subject is asserted until known.

The nullable fallback title separates an unknown subject from a known subjectless message. Known titles and cached previews remain visible, positive preview counts retain their prior singular/plural behavior, and a loaded subjectless message retains “(no subject)”. No layout, controls, navigation, native source, or API changes.

Validation: one new regression failed before the implementation change (four preservation tests passed); all six final loading tests plus 15 existing reader/card/body/navigation tests pass. Production web build and final web typecheck pass. Browser assertions pass in all four before/after cases with no page errors. All eight screenshots were visually inspected. The shell can still be finishing its independent inbox sync in these captures; the intentionally held reader request remains pending throughout.

| Surface | Before | After |
| --- | --- | --- |
| Mobile web light, 390×900 | [Screenshot](before/390-light.png) | [Screenshot](after/390-light.png) |
| Mobile web dark, 390×900 | [Screenshot](before/390-dark.png) | [Screenshot](after/390-dark.png) |
| Desktop light, 1440×900 | [Screenshot](before/1440-light.png) | [Screenshot](after/1440-light.png) |
| Desktop dark, 1440×900 | [Screenshot](before/1440-dark.png) | [Screenshot](after/1440-dark.png) |

Fresh headless Chromium, reduced motion, disposable synthetic SQLite/API, external browser requests blocked. This is mobile web and desktop web evidence, not native iOS/Safari/simulator or screen-reader validation. No native CI was dispatched for this web-copy change. No live mail, send, production migration, credentials, or remote-image prototype work.
