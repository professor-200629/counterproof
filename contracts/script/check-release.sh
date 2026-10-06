#!/usr/bin/env bash
# Release checks for contracts/. Run before committing or deploying:
#
#   bash contracts/script/check-release.sh      (from the repo root)
#   bash script/check-release.sh                (from contracts/)
#
# 1. Dependency pins. `git submodule update` checks out the commits git records for lib/
#    (the gitlinks), not the ones in foundry.lock. A wrong gitlink therefore builds and passes
#    tests against different library code with no error. This check requires that the gitlinks
#    in the index (what the next commit records, and what a fresh clone gets) and the
#    checked-out submodules are exactly the commits foundry.lock names, and that each lock tag
#    resolves to its rev.
# 2. Key hygiene in README.md. No documented command may type a private key on the command
#    line (`export DEPLOYER_PRIVATE_KEY=...`, `--private-key ...`), because an interactive
#    shell saves that line in plain text to its history file.
#
# Exit status: 0 when every check passes, 1 when any check fails.
set -u

cd "$(dirname "$0")/.." || exit 2
fail=0

say_fail() { echo "FAIL  $*"; fail=1; }
say_ok()   { echo "ok    $*"; }
say_warn() { echo "WARN  $*"; }

describe() { # describe <submodule path> <rev>
    git -C "$1" describe --tags --always "$2" 2>/dev/null || echo "$2 (commit not present locally)"
}

# --- 1. dependency pins ---------------------------------------------------------------------

if [ ! -f foundry.lock ]; then
    say_fail "foundry.lock is missing"
else
    # "lib/x" (or "lib\\x" as forge writes it on Windows) -> tag name and rev.
    lock=$(awk -F'"' '
        /^[[:space:]]*"lib/ { name = $2; gsub(/\\\\/, "/", name); tag[name] = "" }
        /"name"[[:space:]]*:/ { tag[name] = $4 }
        /"rev"[[:space:]]*:/ { rev[name] = $4 }
        END { for (n in rev) print n, rev[n], (tag[n] == "" ? "-" : tag[n]) }
    ' foundry.lock)

    gitlinks=$(git ls-files -s -- lib | awk '$1 == "160000" { print $4, $2 }')
    if [ -z "$gitlinks" ]; then
        say_fail "no submodules recorded under contracts/lib in the git index"
    fi

    while read -r path index_rev; do
        [ -z "$path" ] && continue
        lock_line=$(printf '%s\n' "$lock" | awk -v p="$path" '$1 == p')
        if [ -z "$lock_line" ]; then
            say_fail "$path: not pinned in foundry.lock"
            continue
        fi
        lock_rev=$(printf '%s\n' "$lock_line" | awk '{ print $2 }')
        lock_tag=$(printf '%s\n' "$lock_line" | awk '{ print $3 }')
        want="$lock_rev"
        [ "$lock_tag" != "-" ] && want="$lock_tag ($lock_rev)"

        if [ "$lock_tag" != "-" ]; then
            tag_rev=$(git -C "$path" rev-parse -q --verify "refs/tags/$lock_tag^{commit}" 2>/dev/null || true)
            if [ -z "$tag_rev" ]; then
                say_warn "$path: tag $lock_tag is not present locally; cannot cross-check it"
            elif [ "$tag_rev" != "$lock_rev" ]; then
                say_fail "$path: foundry.lock tag $lock_tag is $tag_rev, but the lock rev is $lock_rev"
            fi
        fi

        if [ "$index_rev" = "$lock_rev" ]; then
            say_ok "$path: git index pins $want"
        else
            say_fail "$path: git index pins $(describe "$path" "$index_rev") [$index_rev], foundry.lock says $want." \
                "Fix: git add $(git rev-parse --show-prefix)$path (with the submodule checked out at $lock_rev)"
        fi

        checkout_rev=$(git -C "$path" rev-parse HEAD 2>/dev/null || echo "not-checked-out")
        if [ "$checkout_rev" = "$lock_rev" ]; then
            say_ok "$path: checked out at $want"
        else
            say_fail "$path: checked out at $(describe "$path" "$checkout_rev"), foundry.lock says $want"
        fi

        head_rev=$(git ls-tree HEAD -- "$path" 2>/dev/null | awk '{ print $3 }')
        if [ -n "$head_rev" ] && [ "$head_rev" != "$lock_rev" ] && [ "$index_rev" = "$lock_rev" ]; then
            say_warn "$path: the last commit still pins $(describe "$path" "$head_rev"); the correct pin is staged, commit it"
        fi
    done <<EOF
$gitlinks
EOF
fi

# --- 2. README key hygiene ------------------------------------------------------------------

# Only fenced code blocks are commands; prose may quote the forbidden forms as a warning.
inline_key=$(awk '/^[[:space:]]*```/ { code = !code; next } code { print NR ": " $0 }' README.md |
    grep -E 'export[[:space:]]+[A-Z_]*PRIVATE_KEY=|^[0-9]+: [[:space:]]*[A-Z_]*PRIVATE_KEY=[^[:space:]]+[[:space:]]+[a-z]|echo[^|]*PRIVATE_KEY=|--private-key[[:space:]=]+[^[:space:]]' || true)
if [ -n "$inline_key" ]; then
    say_fail "README.md types a private key on the command line (it would land in shell history):"
    printf '%s\n' "$inline_key" | sed 's/^/        README.md:/'
else
    say_ok "README.md never types a private key on the command line"
fi

if [ "$fail" -ne 0 ]; then
    echo "check-release: FAILED"
    exit 1
fi
echo "check-release: all checks passed"
