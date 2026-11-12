# Viewport precondition evidence

The test-only fdf62684647fdfbf36c078b0f089c76c0c1dec37 baseline failed Foundation compilation because its helper and checks omitted CoreGraphics imports. Geometry and grammar did not execute. That receipt remains unchanged.

Root added only the two imports at 0bd8e7876dd2bf1b32f99009cc9c486cca3eb1ad. Compile passed, all 12 used rectangle controls passed, and all 38 Swift grammar inputs parsed with an empty log. The 39 input hashes, clean start/end identity, and resource receipts are retained separately. Wrapper 88357 completed in 1.960s; baseline wrapper 87248 failed in 1.265s. TemporaryDirectory removed the scratch binary.

This proves pure geometry and grammar, not SwiftUI/XCTest compilation, event routing, keyboard focus, native AX reveals, or Apple UI behavior. No API, 275-controller suite, runner, provider, or simulator check was repeated. Current hosted acceptance remains pending.
