# October 13 replacement harness review — paid run held

No paid Railway compute started; service and volume remain intact. The replacement harness is in `staging/railway-search`. The exact Mac-only harness remains unavailable and is not represented as recovered.

## Outcome

The final balanced-workload, network-disabled Linux container run passed all four children’s correctness checks and exact paired signatures, with actual FULL/FULL durability. The 1k pair passed the unchanged relative gates. The 10k pair failed: common-query p95 was **210.896 → 370.967ms (1.759×)** against the 1.25× limit. Several other read gates also failed; persistence passed. The supervisor stopped before trial two and mixed phases. **This is not a performance acceptance or Railway readiness pass.**

Both common-query paths prepared 17 statements, projected 51 page rows for a 50-message page, loaded 50 label associations and used eight account-page queries with identical mailbox revision signatures. The observed CPU and wall-time increase remains unexplained; matching logical work does not exclude a regression or establish environmental causation. No durability or acceptance threshold was relaxed, and no speculative application fix was made.

Raw final reports, resource timelines and the failed manifest are retained as deterministic gzip files here. `summary.json` records exact revision/source/raw hashes and every relative comparison. They were collected in a local 4-CPU, 1GiB, network-disabled container, not on Railway storage or compute. Sampled process RSS remained below 257MiB. Local mode bypasses Railway-specific identity/memory/network checks; these results are preparatory only.

Earlier diagnostic evidence remains in `/workspace/pr235-evidence/oct13`: the erroneous 16MiB file-limit rejection, the initial 1.525× account-query gate, a 1,008ms mixed-reader backlog, and the pre-balancing container failures. Those failures are preserved and are not replaced by later results. A narrow fairness correction added baseline legacy control repeats where the candidate performs metadata requests; main's strict query schema rejects the metadata parameter, so controls omit it. Workload counts now match apart from the candidate's explicit full-body rejection check. This change does not prove the cause of the earlier timing differences.

## Verified preparation

- Exact main/integration reconstruction and separate frozen dependency installs passed.
- Pinned runtime image built. A network-disabled 10k mixed smoke completed all six planned/offered operations. Full combined Docker build with network source acquisition has not passed here; the original apt-based build failed container DNS, and the replacement runtime removes that apt step.
- Process-group termination after parent exit and strict p95 gate tests passed. Independent review approved fixture coverage, matched workload ordering, all-connection durability assertions, fail-fast peer termination and atomic partial reports.
- Fresh integration previously passed 36 focused tests, workspace typechecks and production build. Full API results remain 742 pass / 1 fail; main 740 pass. Included diagnostic scripts deterministically reproduce the pre-existing two-clock MCP fixture defect on both revisions without modifying security bounds or application source. The historical suite response was not captured, so that individual failure is not conclusively attributed.

## Remaining gates and operations

The fixed follow-up controls reproduced non-code measurement instability: reversed order passed all relative gates, while identical candidate source varied by up to 5.751×. See [diagnostic evidence and the conservative admission guard](diagnostics/README.md). The original red result remains red; no specific host cause or absence of a regression is proven. A revised target attempt can now reject an unstable baseline before its first 10k candidate, without retries or weaker thresholds. Paid execution still requires the parent to confirm protocol and operator readiness below. No representative Railway performance, sustained mixed-load acceptance, production capacity or crash/power-loss durability is established.

The authenticated browser operator can see deployment actions on the old crashed deployment. Documented Abort applies to initialization/building; future queued-state cancellation remains unverified. Before any paid attempt the parent must confirm operator coverage, service-preserving cancellation across relevant states and the absolute 45-minute lifecycle deadline. Exact staged source/config/variable operations and the local timeout safeguards are documented in the harness README. Service/volume deletion is excluded.

The existing approval remains $1 additional usage / 45-minute lifecycle / 20-minute measurement. Conservative planning is approximately $0.326 before tax including the stated 1GB egress allowance and a 24-hour full-volume storage reserve; it is not a platform billing cap. The preserved volume may continue accruing charges after that period. No deployment, resource deletion, production action, duplicate CI dispatch or Mac access occurred during preparation.
