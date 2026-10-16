# Orca compose verification map

The source is `apps/web/scripts/compose-fixture-e2e.mjs` backed by `apps/api/scripts/compose-fixture.ts`. Run `python3 scripts/pstack/verify.py trial <new-evidence-directory>` from the repo root. The complete existing journey has **16 asserted scenarios** (eight in each theme) and **eight synthetic deliveries**. Individual map entries describe related scenarios; they are not independent CLI flags.

| Feature | User outcome |
| --- | --- |
| [Compose and send](compose-and-send.md) | Writing survives reload; correct recipients/attachments; one synthetic send. |
| [Account reply](account-reply.md) | Reply uses the thread's owning account. |
| [Draft recovery](draft-recovery.md) | Initialization, close/discard and conflict recovery preserve the right writing. |
| [Delivery failures](delivery-failures.md) | Invalid, uncertain and unauthorized states do not cause unsafe delivery. |

Light/dark screenshots prove observed states only. Review their labels and contrast; a screenshot alone does not prove all hover/pressed/disabled states. Use the existing dedicated harnesses and hosted CI for native UI and other features. Search benchmarks and reader catch-up evidence belong to their active workstreams and are not duplicated here.
