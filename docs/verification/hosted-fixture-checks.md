# Hosted fixture checks

`Fixture Checks` complements (and does not replace) `Unit Tests` on pull requests
and pushes to main. It can also be manually dispatched after it reaches main.
All actions are pinned to immutable commits; dependencies use `bun.lock` and Bun
1.3.14. No repository secrets, Apple credentials, live providers, deployments, or
self-hosted/larger runners are used. The workflow token has only `contents: read`
and checkout does not persist credentials. Superseded runs are cancelled.

## Coverage

- **Ubuntu 24.04:** production workspace build, existing API smoke tests, then the
  existing Chromium compose harness against the real API and temporary SQLite.
  The harness checks 14 light/dark scenarios and eight synthetic provider calls.
  It uses a new browser profile and blocks external browser origins.
- **macOS 26:** Xcode 26.4.1, unsigned simulator build, the complete `OrcaTests`
  unit target, and the existing `compose` UI scope in light and dark appearances
  (tests 01 and 14–18). This is intentionally not the entire native UI suite.
  It does not run the separate `Tools/check-api.sh` Swift command-line helper.
  The job discovers an available iPhone on the iOS 26.4 runtime and creates its
  own simulator; no existing device is erased or uninstalled from. The shared
  test harness receives unique DerivedData and result paths, with parallel
  simulator cloning disabled.

A passing check verifies the checked-out PR merge commit, not unpublished local
changes. `identity.log` records that exact SHA, event/head SHAs, runner image,
architecture, runtime/tool versions, and the selected simulator identity.
A missing pinned Xcode/runtime is a failure requiring an explicit inventory
update, rather than silently substituting another toolchain.

## Isolation and evidence

Each fixture binds literal loopback on an OS-assigned port, starts without local
`.env` files, seeds synthetic `example.com` accounts, and stubs provider delivery.
The browser and API execute together on the GitHub runner. Native tests use the
runner's loopback API. Neither route accesses a developer's computer or mailbox.

The fixture, private logs, database, connection file, injected xctestrun,
DerivedData, and raw xcresult bundles live in a unique private temporary directory.
Exit, failure, and cancellation cleanup stops only the owned fixture and removes
only the owned simulator and temporary directory. The hosted runner is disposable
if a forceful runner shutdown prevents its exit trap.

Before cleanup, an allowlist exporter redacts the ephemeral session/bearer,
Bearer headers, and session cookies from text evidence. Only sanitized logs,
browser results, native xcresult JSON summaries/test trees, and synthetic
screenshots are uploaded for **7 days**, with run/attempt-specific artifact names.
Raw xcresult bundles may contain credential-bearing launch arguments, so they
are never uploaded. Neither are connection files, databases, browser storage,
traces, xctestrun files, or DerivedData. Evidence export fails closed and removes
partially prepared artifacts if sanitization or xcresult export fails.

## Verification commands

```sh
python3 scripts/ci/test-export-evidence.py
bash -n scripts/ci/fixture-check.sh
bun install --frozen-lockfile
bun run build
bun run test:smoke
bunx --no-install playwright install --with-deps chromium
ORCA_CI_EVIDENCE_DIR=/tmp/new-orca-browser-evidence bash scripts/ci/fixture-check.sh browser
```

The iOS command requires macOS, installed Xcode 26.4.1, and an available iOS 26.4
simulator. It creates and deletes a new CI-owned simulator; do not pass an existing
personal device. On the hosted runner use `bash scripts/ci/fixture-check.sh ios`.

Standard hosted Linux/macOS runner execution is free for public repositories.
Artifact storage has separate usage rules; retention here is bounded to 7 days.
The workflow does not change billing settings or branch-protection requirements.

References:
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [macOS 26 arm64 runner inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md)
- [Playwright CI guidance](https://playwright.dev/docs/ci)
