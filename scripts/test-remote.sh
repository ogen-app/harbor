#!/usr/bin/env bash
# Run the Go suite (`make test`) on another machine over SSH, so the build and
# the tests don't load this one.
#
#   scripts/test-remote.sh            # make test
#   scripts/test-remote.sh build test # any make targets
#
# The working tree, uncommitted changes included, is rsynced to
# ~/src/harbor-<checkout dir> on REMOTE_HOST (default: mac2, an ~/.ssh/config
# alias), minus build output, node_modules and .env. Each checkout or worktree
# gets its own remote directory, so suites from several worktrees can run at
# once. The exit code is the suite's.
#
# The remote needs Go and make on its login shell's PATH; the Makefile's
# GOTOOLCHAIN fetches the pinned Go there when it has another.
set -euo pipefail

host=${REMOTE_HOST:-mac2}
root=$(git rev-parse --show-toplevel)
name=$(basename "$root")
dir="src/harbor-$name"

# Explicit rather than a .gitignore merge: rsync reads its leading ! as "clear
# the list", not git's negation, which would drop the dist placeholder the Go
# embed needs to compile.
filters=(
	--exclude .git --exclude .claude --exclude .env --exclude node_modules/
	--exclude /server --exclude /tmp/ --exclude '*.out'
	--exclude /ui/.next/ --exclude /ui/out/
	--include /src/ui/dist/index.html --exclude '/src/ui/dist/*'
)

# macOS's rsync has no --mkpath and won't create missing parents.
ssh "$host" "mkdir -p ~/$dir"
rsync -az --delete "${filters[@]}" "$root/" "$host:$dir/"

targets=$(printf '%q ' "${@:-test}")

# A terminal only when there is one: colours for a person, none for a pipe.
tty=-T
[ -t 1 ] && tty=-t
set +e
ssh "$tty" "$host" "zsh -lc 'cd ~/$dir && make $targets'"
rc=$?
set -e
exit $rc
