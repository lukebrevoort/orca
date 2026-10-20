# Pinned upstream coverage

Inventory: **54 upstream skills, 23 playbooks** at `1e5c90a4b6f249917bd21fe361b3a2a7deb741b8`. “Adapted” means an explicit local procedure, with differences stated; it does not mean native execution or complete implementation of the upstream automation. “Unsupported” means deliberately absent. “Integrated” below describes Orca-owned runnable infrastructure, not a Cursor compatibility claim. Five local skill entry points are installed; other methods are guidance selected by poteto-mode.

| Runnable local infrastructure | Status | Verification contract |
| --- | --- | --- |
| `verify-orca` lifecycle | Integrated | `doctor`, `trial`, `evidence` in `scripts/pstack/verify.py`; actual run artifacts determine pass/fail. |
| Feature map | Integrated | Four compose features grounded in the existing browser/API harness; not full-product coverage. |
| Existing hosted native CI | Integrated by reference | Reuse relevant hosted runs; Linux trial cannot attest native behavior. |

## Skills

| Upstream skill | Status | Local mapping / reason |
| --- | --- | --- |
| `architect` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `arena` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `automate-me` | Unsupported | Transcript-mining personal mode generation is not implemented; no transcript access assumed. |
| `benchmark-checklist` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `blast-radius` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `bro` | Unsupported | Upstream personality/response mode is not registered; local writing guidance remains in AGENTS. |
| `correct` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `create-verification-skill` | Adapted | `.agents/skills/create-verification-skill/SKILL.md` |
| `figure-it-out` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `how` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `in-your-own-words` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `interrogate` | Adapted | `.agents/skills/interrogate/SKILL.md`; independent available reviewers, no claimed model diversity. |
| `ketchup` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `maintain-verification-skill` | Adapted | Maintenance procedure in local `create-verification-skill`. |
| `make-bot-ui` | Unsupported | Webhook/bot UI/Tailscale provisioning and communications are outside authorization. |
| `no-comments` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `poteto-help` | Adapted | `docs/pstack/README.md` and local playbook selection; no separate slash skill. |
| `poteto-mode` | Adapted | `.agents/skills/poteto-mode/SKILL.md` |
| `principle-attack-the-premise` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-boundary-discipline` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-build-the-lever` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-encode-lessons-in-structure` | Adapted | `.agents/skills/encode-lessons-in-structure/SKILL.md` |
| `principle-exhaust-the-design-space` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-experience-first` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-explain-the-number` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-fix-root-causes` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-foundational-thinking` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-guard-the-context-window` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-laziness-protocol` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-make-operations-idempotent` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-migrate-callers-then-delete-legacy-apis` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-minimize-reader-load` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-model-the-domain` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-never-block-on-the-human` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-outcome-oriented-execution` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-prove-it-works` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-redesign-from-first-principles` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-separate-before-serializing-shared-state` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-sequence-verifiable-units` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-subtract-before-you-add` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-test-behavior-not-implementation` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `principle-type-system-discipline` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `recall` | Unsupported | Cursor chat-history retrieval has no equivalent installed here; use explicit session handoffs. |
| `reflect` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `setup-pstack` | Unsupported | Cursor model detection and ~/.cursor rules configuration are not implemented. |
| `sharpen` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `show-me-your-work` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `swarm` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `tdd` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `teach` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `technical-writing` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `typescript-best-practices` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `unslop` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |
| `why` | Adapted | Supporting method in `methods.md`; guidance only, not a separately registered skill. |

## Playbooks

| Upstream playbook | Status | Local mapping / difference |
| --- | --- | --- |
| `authoring-a-skill` | Adapted | [Procedure](playbooks.md#authoring-a-skill); available tools and explicit permission boundaries. |
| `autonomous-run` | Adapted | [Procedure](playbooks.md#autonomous-run); current session only; no /loop or schedules. |
| `autopilot-full` | Unsupported | [Procedure](playbooks.md#autopilot-full); merge-to-completion is prohibited. |
| `autopilot-stack` | Adapted | [Procedure](playbooks.md#autopilot-stack); available tools and explicit permission boundaries. |
| `babysit` | Adapted | [Procedure](playbooks.md#babysit); available tools and explicit permission boundaries. |
| `bug-fix` | Adapted | [Procedure](playbooks.md#bug-fix); available tools and explicit permission boundaries. |
| `eval` | Adapted | [Procedure](playbooks.md#eval); available tools and explicit permission boundaries. |
| `feature` | Adapted | [Procedure](playbooks.md#feature); available tools and explicit permission boundaries. |
| `hillclimb` | Adapted | [Procedure](playbooks.md#hillclimb); available tools and explicit permission boundaries. |
| `investigation` | Adapted | [Procedure](playbooks.md#investigation); available tools and explicit permission boundaries. |
| `multi-phase-plan` | Adapted | [Procedure](playbooks.md#multi-phase-plan); available tools and explicit permission boundaries. |
| `opening-a-pr` | Adapted | [Procedure](playbooks.md#opening-a-pr); available tools and explicit permission boundaries. |
| `orchestrate` | Adapted | [Procedure](playbooks.md#orchestrate); finite authorized work; no persistent coordinator. |
| `pause-safely` | Adapted | [Procedure](playbooks.md#pause-safely); available tools and explicit permission boundaries. |
| `perf-issue` | Adapted | [Procedure](playbooks.md#perf-issue); available tools and explicit permission boundaries. |
| `prototype` | Adapted | [Procedure](playbooks.md#prototype); available tools and explicit permission boundaries. |
| `refactoring` | Adapted | [Procedure](playbooks.md#refactoring); available tools and explicit permission boundaries. |
| `runtime-forensics` | Adapted | [Procedure](playbooks.md#runtime-forensics); available tools and explicit permission boundaries. |
| `session-pickup` | Adapted | [Procedure](playbooks.md#session-pickup); available tools and explicit permission boundaries. |
| `shipping` | Adapted | [Procedure](playbooks.md#shipping); review-ready only, no landing commands. |
| `trace-forensics` | Adapted | [Procedure](playbooks.md#trace-forensics); available tools and explicit permission boundaries. |
| `visual-parity` | Adapted | [Procedure](playbooks.md#visual-parity); available tools and explicit permission boundaries. |
| `worktree-cleanup` | Adapted | [Procedure](playbooks.md#worktree-cleanup); trial-owned cleanup only; general pruning excluded. |

## Other upstream components

| Component | Status | Reason |
| --- | --- | --- |
| `agents/poteto-agent.md`, `agents/comment-sicko.md` | Unsupported as agents | No Cursor agent registration. Local review/clarity procedures cover relevant intent. |
| `automations/benny` | Unsupported | Slack intake, scheduled/event automation and bot setup are not authorized or installed. |
| Bootstrap, watch-pr, orch, worktree-audit, log scripts | Unsupported | Inspected as source where relevant, never copied or executed. Local CLI owns verification only. |
| Cursor `/loop`, custom modes and model aliases | Unsupported | No native Codex equivalents assumed. Explicit skill reads and bounded session work replace them. |
| External `cursor-team-kit` deslop/control-ui/control-cli; Cursor create-skill | Unsupported as dependencies | Not bundled upstream here or installed locally. Orca fixture harness and local authoring/review guidance replace the required functions. |

This is complete inventory/accounting, not a claim that every upstream capability has been implemented. New surfaces need their own verified mapping. No browser compose result proves native UI, Gmail delivery, search latency or long-thread reader correctness.
