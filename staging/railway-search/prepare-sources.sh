#!/bin/sh
set -eu
SOURCE_ROOT=${PERF_SOURCE_ROOT:-/sources}
test ! -e "$SOURCE_ROOT/base"
mkdir -p "$SOURCE_ROOT"
git init "$SOURCE_ROOT/base"
git -C "$SOURCE_ROOT/base" remote add origin https://github.com/lukebrevoort/orca.git
git -C "$SOURCE_ROOT/base" fetch origin 0e6805131a9c8386107bf70f598e2b61b0cf6a0b 993f6227bfc8d5d79513600455758c8197560666
git -C "$SOURCE_ROOT/base" checkout --detach 0e6805131a9c8386107bf70f598e2b61b0cf6a0b
git -C "$SOURCE_ROOT/base" worktree add --detach "$SOURCE_ROOT/head" 0e6805131a9c8386107bf70f598e2b61b0cf6a0b
git -C "$SOURCE_ROOT/head" -c user.name=Harness -c user.email=harness@example.test merge --no-commit --no-ff 993f6227bfc8d5d79513600455758c8197560666
test "$(git -C "$SOURCE_ROOT/head" write-tree)" = 87c2ea4907c287f20852c0a4bc5d242ded2bd16b
# Reconstruct the exact previously reviewed local commit object, not a moving branch.
export GIT_AUTHOR_NAME='Luke Brevoort' GIT_AUTHOR_EMAIL='luke@brevoort.com'
export GIT_COMMITTER_NAME='Luke Brevoort' GIT_COMMITTER_EMAIL='luke@brevoort.com'
export GIT_AUTHOR_DATE='2026-10-13T14:19:02+0000' GIT_COMMITTER_DATE='2026-10-13T14:19:02+0000'
candidate=$(git -C "$SOURCE_ROOT/head" commit-tree 87c2ea4907c287f20852c0a4bc5d242ded2bd16b -p 0e6805131a9c8386107bf70f598e2b61b0cf6a0b -p 993f6227bfc8d5d79513600455758c8197560666 -m "Merge commit '993f6227bfc8d5d79513600455758c8197560666' into HEAD")
test "$candidate" = fdc78bce2d4e3169f870aaaffd62da20d9f46f30
git -C "$SOURCE_ROOT/head" reset --hard "$candidate"
(cd "$SOURCE_ROOT/base" && bun install --frozen-lockfile --ignore-scripts)
(cd "$SOURCE_ROOT/head" && bun install --frozen-lockfile --ignore-scripts)
test "$(bun --version)" = 1.3.14
