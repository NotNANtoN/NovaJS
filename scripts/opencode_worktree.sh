#!/bin/bash
# Sets up a worktree for an opencode (GLM) task. Usage:
#   scripts/opencode_worktree.sh <name> [base-ref]
# Creates .claude/worktrees/opencode-<name> from base-ref (default: the
# current branch), gives it a real COPY of Nova_Data (opencode's docker
# sandbox can't follow symlinks out of the mount; cp -Rp preserves the
# resource-fork xattrs — verified — though the sandbox's linux kernel
# still can't read forks via ..namedfork, so PLUG-INS won't parse there;
# stock "Nova Files" .ndat data lives in data forks and parses fine),
# installs deps, and prebuilds so targeted jasmine runs work.
#
# Sandbox limitations to expect (as of 2026-07-28):
# - git is NON-FUNCTIONAL inside the sandbox (the main repo's .git is
#   outside the mount): tell opencode to skip committing; review and
#   commit its diff from the mac side afterward.
# - `npx turbo run test --force` fails at novadatainterface's ts-node
#   defaults step under linux; have it run targeted jasmine suites.
set -euo pipefail

NAME="${1:?usage: opencode_worktree.sh <name> [base-ref]}"
BASE="${2:-$(git branch --show-current)}"
ROOT="$(git rev-parse --path-format=absolute --git-common-dir)/.."
W="$ROOT/.claude/worktrees/opencode-$NAME"
CANON="/Users/matthew/Projects/novajs-parsing/packages/nova/Nova_Data"

git worktree add --detach "$W" "$BASE"
mkdir -p "$W/packages/nova/Nova_Data"
cp -Rp "$CANON/Nova Files" "$W/packages/nova/Nova_Data/Nova Files"
cp -Rp "$CANON/Plug-ins" "$W/packages/nova/Nova_Data/Plug-ins"
# Verify the copy kept its resource forks (the historic silent-corruption
# trap): any sampled plug-in must still carry com.apple.ResourceFork.
if ! ls -l@ "$W/packages/nova/Nova_Data/Plug-ins/"* 2>/dev/null \
        | grep -q com.apple.ResourceFork; then
    echo "ERROR: resource forks did not survive the copy" >&2
    exit 1
fi
(cd "$W" && npm install && npx turbo run build --force)
echo "ready: cd $W && ~/Projects/opencode_sandboxed/bin/opencode run \"...\""
echo "cleanup: git worktree remove --force $W   (branch/commit first!)"
