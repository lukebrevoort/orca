---
name: interrogate
description: Independently review an Orca patch for correctness, safety, maintainability and honest verification claims.
---

# Interrogate (Codex adapter)

Adapted from pstack `interrogate`; this is not its native Cursor multi-model panel.

Resolve the base and head to immutable commit IDs and state the intended behavior before review. Review the full diff and relevant callers, tests, fixture lifecycle and evidence contracts. Give each independent reviewer the same intent, base/head, scope and rubric; ask for concrete file/line citations and reproducible failure conditions. Use authorized available reviewer agents, preferably separate safety/correctness and maintainability/evidence reviews. Do not assume different agents mean different models. If no independent agent is available, report that limitation and request human review in the draft PR; never relabel self-review as independent.

Rubric: Does behavior satisfy intent? Are input, process, filesystem and credential boundaries safe? Does cleanup own what it deletes? Can a failing or stale run be reported as passing? Are assertions about user behavior rather than implementation? Can another developer reproduce the result with documented prerequisites? Is the change simpler than viable alternatives?

Return intent, reviewer identities and known models, exact reviewed commits, findings and evidence. Classify each as **Act on**, **Consider**, **Noted**, or **Dismissed** with a reason; merge duplicates and retain disagreements. Do not auto-apply reviewer suggestions during a review-only request. During an authorized implementation, fix blocking findings and rerun relevant checks, then obtain review of changed code. Review approval never authorizes merging or external messages.
