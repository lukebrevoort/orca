# Approved quiet controls — validation checkpoint

Option A moves Expand all/Collapse all into a labeled overflow disclosure, replaces the filled earlier-message bar with a compact divider, and shows unread/latest shortcuts only when their target is offscreen. Native uses the existing navigation bar for its overflow menu. Controls retain 44px targets; original messages, priority behavior, attachment rendering and read-state behavior are unchanged. #236's separate denser inbox remains a design-only preview; the sidebar must remain.

## Local RED/GREEN

The new rendered menu regression failed before implementation because `.reader-thread-menu` was missing. After implementation, the focused web run passed 66 tests / 349 assertions. Final checkpoint reruns are recorded in the task; hosted checks are the authority for native validation.

## Native environment failure (preserved, not a source fix)

Toolchain: Xcode 26.4.1, build 17E202, `/Applications/Xcode.app/Contents/Developer`.

Exact failed command from repository root:

```sh
xcodebuild -project apps/ios/Orca.xcodeproj -scheme Orca -sdk iphonesimulator -configuration Debug -derivedDataPath /Users/lbrevoort/Documents/Codex/2026-10-08/task-3/implementation-build CODE_SIGNING_ALLOWED=NO -jobs 2 build
```

Decisive diagnostic:

```text
Assets.xcassets: error: No available simulator runtimes for platform iphonesimulator. SimServiceContext supportedRuntimes=[]
CoreSimulatorService connection became invalid. Simulator services will no longer be available.
Cannot talk to the service used to manage runtime disk images (simdiskimaged) because its launchd job is not registered or was unloaded
```

Failure: `CompileAssetCatalogVariant thinned`, after local CoreSimulatorService connection failures. This does not establish an asset-source defect; do not change asset contents to suppress it. Full original log retained privately in `reader-verification/quiet-local-failure/checks.log` outside the repository. The subsequent arm64-only retry never started because the execution connection disconnected.

Native validation is intentionally unfinished at this checkpoint. Existing hosted Native Reader Checks on macos-26 / Xcode 26.4.1 will verify the exact new head using an owned simulator and sanitized screenshots/logs. No further local native build is required to publish source for review. No merge or release authorized.

Independent review of `31f4d32` found that changing an earlier message's height could leave the latest shortcut stale. A new integration regression failed (3 pass / 1 fail) before observing the message-list wrapper, then passed after the fix. Typecheck and 67 focused tests pass (352 assertions). Native test07 additionally checks the standard conversation menu, expand/collapse behavior and captures its open state; hosted execution is required before claiming that runtime coverage passes.

Actual desktop browser verification found a separate fixed-position trap: the reader entrance animation retains a transform, making descendant fixed navigation anchor below the long document. Moving the navigation outside `.reader-document` restores viewport anchoring. The hosted profile now asserts that the latest shortcut is inside the viewport before clicking (so auto-scroll cannot mask this regression). Local browser verification confirmed latest/unread focus transfer, contextual hide/show, 24-card expand / single-entry collapse, and light/dark menu focus visibility. Independent static review accepted the earlier resize-observer fix.
