# Gmail benchmark source identity follow-up

The independent BRE-461 review found that the benchmark checked only `sync.ts`, although the executed path also imports the normalizer, DB bindings and shared modules. Existing clean db8 receipts remain valid; dirty source could otherwise be labeled as a requested commit.

Actual baseline CLI reproduction at clean parent `4f582a97dc325161a8ed268c6622cd03bf258397` temporarily changed only the imported normalizer function to throw a synthetic marker. The unmodified benchmark accepted the requested SHA and executed that modified function in its first worker. It exited 1 with the marker; it did not complete or write a mislabeled report. [Raw failure](baseline.log) and [scope/identity](baseline.json) are retained. The source was restored byte-for-byte in `finally`.

The fix requires the requested commit to equal the clean executing HEAD, records the complete Git tree and lockfile blob, and checks identity before and after every worker plus before publishing. Both paired SQL revisions execute the same candidate production source, as explicitly recorded; SQL remains read from each immutable revision. Frozen dependencies remain a prerequisite: a clean Git tree does not hash installed `node_modules`.

At source commit `490fb3e42df6b24c02b66818afbb82774b27e141`, three actual CLI negative cases rejected dirty imported normalizer code, untracked source and a different requested HEAD, without executing the mutation or writing a report. [Checkpoint receipt](source-checkpoint-490fb3e4.json). These are source-checkpoint results, not a full final-head benchmark or application runtime approval.

Run the same negative cases from a clean committed checkout, with a new output directory outside the repository:

```sh
python3 /tmp/orca-ui-heavy-slot.py python3 docs/verification/bre-461/provenance/probe.py /tmp/NEW-provenance
```

The probe modifies only the synthetic throw location or a uniquely named untracked source file, restores owned changes in `finally`, and refuses existing outputs. The positive paired Gmail benchmark must also finish at the final clean head using the documented BRE-461 command. Final full gates, API/query evidence, paired work and independent review are separate requirements. No provider or production database access occurs.
