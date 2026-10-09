# Native quiet-reader launch — f6a0d3b

Source: f6a0d3b63188dbb2f5917d72b56d5b19d3fcf7cf, PR #237. This branch adds synthetic verification evidence only; it does not change implementation or the combined cloud review.

## Actual local outcome

On October 9, 2026, the exact source built successfully with Xcode 26.4.1, unsigned, against the installed iOS 26.4.1 simulator runtime. The earlier asset-compilation failure reproduced under the filesystem sandbox, but runtime discovery and the build succeeded with normal authorized CoreSimulator access. No runtime download or signing change was needed.

The app launched against a loopback-only 24-message fixture with 3 unread messages. It opened at message22, with 21 earlier messages hidden and later messages collapsed. The earlier-message disclosure successfully revealed and re-hid history. Light and dark captures were inspected from actual simulator pixels. Fixture read writes are no-ops; other mail mutations are blocked. No live account was used.

## Remaining native issue

At initial first-unread entry, message24 is below the viewport, but Jump to latest is absent. With earlier history revealed at the top, both first-unread and latest are below the viewport, yet both contextual jumps remain absent. The screenshot history-expanded.png and accessibility observations reproduce this on the exact source. This needs diagnosis before claiming complete native quiet-navigation verification. The hosted native suite passed, but its existing latest-entry/menu test did not catch this 24-message scenario.

The toolbar ellipsis renders correctly. The local computer-use accessibility bridge did not expose the iOS navigation-bar controls, and its window screenshots were blank; screenshots here came from simctl. The already-passing hosted native artifact contains menu evidence, but local menu interaction was not reverified.

## Captures

- reader-light.png — first unread, light mode.
- reader-dark.png — same state, dark mode.
- history-expanded.png — earlier collapsed message cards visible, dark mode; contextual jumps missing.

## Reproduction

Build the exact source, unsigned, using an installed simulator runtime:

    xcodebuild -project apps/ios/Orca.xcodeproj -scheme Orca -sdk iphonesimulator -configuration Debug -destination 'platform=iOS Simulator,id=<owned-simulator>' -derivedDataPath <owned-derived-data> CODE_SIGNING_ALLOWED=NO -jobs 2 build

Start the synthetic reader fixture used by the #236/#237 verification, then install and launch the app with --fixture-api-url http://127.0.0.1:4319 --fixture-access-token synthetic-reader-only. In Inbox, scroll to Focus and open Reading room · opening weekend. Toggle Show21earlier messages to reproduce the missing navigation.

Library saving was unavailable in this local session. These repository copies are the explicit synthetic-evidence fallback. No merge or release was performed.
