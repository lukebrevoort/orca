# ROOT type-gate correction

At869ce35f the focused78 tests and actual HTTP/SQLite/work demo executed, but both type stages used incorrect Bun argument order and printed usage with exit0. They were NOT typecheck passes; the original manifest/logs remain unchanged.

ROOT changed only the verification runner: workspace types invoke pinned Node24.22.1 and the installed TypeScript5.9.3 compiler directly with the exact project config. The gate records compiler entry/version/hash and rejects Bun/tsc usage-only0. Applying that guard to the exact retained bad API log changes reported0 into rejection2 while preserving genuine nonzero failures.

Clean f6d0e168fe89b86af99ba06ea5ff55bf8eed2241 then executed real shared+API tsc successfully in10.77s through one resource wrapper. Commands and compiler identity are retained in actual-types-manifest.json. Empty successful compiler logs are expected for the direct compiler command; this is not an inferred package-script execution. Product API/shared bytes remain identical869; no semantic/demo repeat occurred. Final full sequential workspace gates and independent reviews remain pending. This does not publish a wire contract or complete native retrieval.
