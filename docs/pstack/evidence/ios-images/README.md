# Synthetic iOS image evidence

Executable revision: `edcc10f0d9ff3d5566c26ed4daacc5bd75fa8d2a`. iPhone 17 simulator, iOS 26.4.1, Xcode 26.4.1. Images and message bodies are synthetic. No external image fetch occurred in these tests.

| State | Light | Dark |
| --- | --- | --- |
| Blocked again after reopening | [Screenshot](light-images-blocked-after-reopen.png) | [Screenshot](dark-images-blocked-after-reopen.png) |
| Loaded after explicit consent | [Screenshot](light-images-loaded-after-consent.png) | [Screenshot](dark-images-loaded-after-consent.png) |
| Disabled while loading | [Screenshot](light-images-loading-disabled.png) | [Screenshot](dark-images-loading-disabled.png) |

Light screenshots are from final v4; dark blocked/loading from v5, dark loaded from v4. The dark loading capture has incomplete upper navigation rendering, while its disabled label is visible; it is not a whole-screen visual-fidelity claim. The initial light capture was taken before HTML finished rendering and is not used here. Original captures are retained unchanged.

Final consent/navigation regression: light v4 and dark v5 each 1 passed, 0 failed, 0 skipped. The assertions establish explicit request counts, visible loaded raster, reset on reopening, a second in-flight delayed request, disabled control and rejection of the previous reader's late response. Earlier v3 timeout and dark v4 capture discrepancy remain recorded in the task handoff. These results do not establish a full native-suite pass.
