# Give pstack a try in Orca

For a fresh saved cloud instance, start with [reproducible cloud setup](cloud.md).
For implementation, use the [task-to-draft procedure](task-to-pr.md) and its
[status/handoff template](task-template.md). The original trial evidence remains
historical evidence at its recorded commits, not verification of your new task.

This is a repo-local **Codex adaptation** of Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/1e5c90a4b6f249917bd21fe361b3a2a7deb741b8/pstack), pinned to `1e5c90a4b6f249917bd21fe361b3a2a7deb741b8`. It supplies five explicit skill entry points and a runnable synthetic browser/API verification lifecycle. It does not install Cursor's plugin, model routing, background loops or automations. [Coverage](coverage.md) names every upstream skill and playbook, including unsupported capabilities.

From a committed checkout with Python 3.12, git, Bun 1.3.14, Node 24, frozen-lockfile workspace dependencies and Playwright Chromium/OS dependencies already installed:

```bash
python3 scripts/pstack/verify.py doctor
python3 scripts/pstack/verify.py trial /tmp/orca-pstack-first-try
python3 scripts/pstack/verify.py evidence /tmp/orca-pstack-first-try --commit "$(git rev-parse HEAD)"
```

Choose a new output directory each time. The trial builds committed HEAD in disposable scratch, exercises synthetic compose/reply/recovery in both themes, saves evidence, then cleans up. It reuses installed dependencies; it is not a hermetic environment. It does not load your mail or require your Mac. Missing prerequisites are reported rather than installed. The existing CI setup documents provisioning: `bun install --frozen-lockfile` and `bunx --no-install playwright install --with-deps chromium` after reviewing the lockfile and obtaining any required installation approval. Do not run installers merely because upstream suggested them.

In Codex, select `poteto-mode` if repo-local skill discovery is available, or use this portable prompt:

> Read `.agents/skills/poteto-mode/SKILL.md` and `.agents/skills/verify-orca/SKILL.md`. Run the documented synthetic trial, inspect the screenshots, and report the tested SHA and remaining gaps. Do not merge, deploy, send live mail or install anything.

The other explicit entry points are [create-verification-skill](../../.agents/skills/create-verification-skill/SKILL.md), [interrogate](../../.agents/skills/interrogate/SKILL.md), and [encode-lessons-in-structure](../../.agents/skills/encode-lessons-in-structure/SKILL.md). No persistent mode or slash-command registration is assumed. Reading a skill by path works when discovery is unavailable.

For a feature: “Use the local poteto-mode feature procedure for <behavior>. Open an early draft PR, verify the changed surface, and get independent review. Stop at review-ready.” For a bug, supply a symptom and demand failing-then-passing evidence. For performance, use the existing relevant benchmark and matched before/after measurements; the compose trial is not a benchmark.

Existing hosted [Fixture Checks](../../.github/workflows/fixture-checks.yml) and [Native Reader Checks](../../.github/workflows/native-reader.yml) remain the native verification path. Fixture Checks runs on every PR; Native Reader Checks uses path filters. A skipped/non-triggered native job is **not run**, never inferred green from the Linux trial. Reuse completed runs; do not dispatch redundant jobs.

See [playbooks](playbooks.md), [supporting methods](methods.md), [feature map](../../.agents/skills/verify-orca/features/README.md), and [provenance/update instructions](PROVENANCE.md). Evidence from an actual run, not this guide, determines whether a change is verified.

To exercise cleanup after a controlled failure, use a second new output directory:

```bash
python3 scripts/pstack/verify.py trial /tmp/orca-pstack-failure --fail-after doctor
# Expected exit 1; validate it explicitly as failure evidence:
python3 scripts/pstack/verify.py evidence /tmp/orca-pstack-failure --commit "$(git rev-parse HEAD)" --expect-failure
```

The injected failure is a lifecycle test, not a product regression. `--fail-after launch|doctor|drive` chooses the checkpoint. Browser provisioning can use the normal Playwright cache or an explicitly provisioned `ORCA_CHROMIUM_EXECUTABLE` path; the CLI does not download a browser.

The evidence validator checks local file hashes, expected output names, outcome and
source identity against the requested commit. It is not a signed attestation: a
manifest and artifacts can be edited together. Review the linked CI run and
independent review alongside the local proof. Installed dependencies are trusted
prerequisites, not attested by the lockfile hash. The trial rewrites internal
absolute dependency links into scratch and rejects links that escape it.

[Executed trial, screenshots, failure logs and independent reviews](evidence/README.md).
