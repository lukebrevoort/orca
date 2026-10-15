# Saved cloud setup

Run these explicit commands in a checkout containing the P-Stack adapter. They
work independently of Luke's Mac and leave shell profiles, credentials, OAuth,
application configuration and databases alone. Read `AGENTS.md` and the local
`.agents/skills/poteto-mode/SKILL.md` first.

The cloud image must provide **Node 24**, **Python 3.12+**, git, npm (only if Bun
needs installing), and the OS libraries required by Playwright Chromium. Network
access to the npm registry and Playwright browser CDN is needed on a cold cache.
No sudo, apt, migration, live API or browser sign-in is invoked.

```bash
bash scripts/pstack/cloud.sh setup
eval "$(bash scripts/pstack/cloud.sh env)"
bash scripts/pstack/cloud.sh doctor
```

`setup` finds an existing Bun **1.3.14** on PATH, in its private tool directory,
or in this saved environment's `/workspace/.orca-tools/node_modules/.bin`. If
missing, it installs exact `bun@1.3.14` with npm in the private directory. It runs
`bun install --frozen-lockfile` in **this checkout only**, then downloads the
browser specified by locked Playwright **1.62.1**. Review the repository lockfile
before provisioning. Setup is repeatable; each worktree needs its own frozen
workspace installation. The shared browser/runtime cache is reusable. Avoid
concurrent setup processes using the same cache.

The private tool directory defaults to `/workspace/.orca-pstack-tools` when
writable, otherwise `${XDG_CACHE_HOME:-$HOME/.cache}/orca-pstack`. Override it
with an absolute `ORCA_PSTACK_TOOLS` path. This contains only disposable tools
and browser downloads, not mail or credentials. `env` prints shell-quoted exports
and makes no changes; evaluate it in each new shell. Do not add it to a persistent
shell profile. Custom `PLAYWRIGHT_BROWSERS_PATH` and
`ORCA_CHROMIUM_EXECUTABLE` are respected; the latter skips the browser download.
Use `ORCA_PSTACK_BUN` to select an existing exact-version executable explicitly.

The doctor checks the existing verification prerequisites and launches a new
headless browser with an in-memory synthetic page. Missing shared libraries fail
with the original Playwright error. Provision those libraries in the saved cloud
image through its normal approved configuration workflow; the script never
attempts privileged installation. A successful doctor is environment readiness,
not product verification.

After committing the code to test, use the existing verification runner:

```bash
python3 scripts/pstack/verify.py trial /tmp/orca-cloud-trial-unique
python3 scripts/pstack/verify.py evidence /tmp/orca-cloud-trial-unique \
  --commit "$(git rev-parse HEAD)"
```

Use a fresh evidence directory for every attempt, including failures. Keep setup
and doctor output in task-specific logs outside the checkout. The runner reuses
installed dependencies and supplies a resolved browser path to its isolated
fixture. It does not depend on a shell profile or the parent's browser session.
Read [verification limits](README.md) before claiming browser, API or native
coverage. Hosted native checks remain required for relevant changes; Linux does
not substitute for macOS/Xcode.

## Browser CDN blocked in this saved environment

The first October 15 setup attempt installed frozen dependencies but the locked
browser download returned HTTP 403 `Domain forbidden`. The image already contains
`/usr/bin/chromium`. The following explicit alternative passed the launch doctor:

```bash
export ORCA_CHROMIUM_EXECUTABLE=/usr/bin/chromium
bash scripts/pstack/cloud.sh setup
eval "$(bash scripts/pstack/cloud.sh env)"
```

This uses the image's browser, whose version can differ from Playwright's pinned
browser revision. Record `chromium --version` with verification evidence; do not
claim the pinned download path was exercised successfully. On a fresh image
without a browser and with the CDN blocked, browser verification is blocked until
the image provides Chromium or the approved network configuration allows the
browser download. Preserve the failed download log alongside the successful
alternative's log.
