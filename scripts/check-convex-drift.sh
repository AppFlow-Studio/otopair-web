#!/usr/bin/env bash
#
# check-convex-drift.sh  (otopair-web edition, mirror of the mobile guard at
# otopair/scripts/check-convex-drift.sh d7a848a).
#
# Refuses to let a `npx convex dev` push overwrite the shared dev deployment
# without confirming the sibling repo's `convex/` matches. `convex dev` from
# either repo replaces the deployment's ENTIRE function set and schema with
# that repo's `convex/`, deleting anything the pusher lacks — that's how the
# shop portal broke on 2026-08-25 (mobile was ahead of web on healthScore
# work but behind on 8 web-only modules; pushing from mobile deleted them).
#
# Behaviour:
#   - Finds the otopair (mobile) checkout by trying, in order:
#       1. $OTOPAIR_MOBILE_REPO (env override)
#       2. $HOME/Downloads/otopair
#       3. dirname of this repo + /otopair
#     First hit that contains a convex/ subdir wins.
#   - If a checkout is found: diff -rq --exclude=_generated on convex/. Any
#     output means drift → exit 1.
#   - If no checkout is found: WARN on stderr and exit 0. The exit-0 keeps
#     CI green on hosts without the sibling repo; the warning is critical
#     because SILENCE IS INDISTINGUISHABLE FROM "no drift" — the exact
#     failure mode the mobile guard hit before d7a848a.
#   - OTOPAIR_ALLOW_CONVEX_DRIFT=1 escape hatch: prints drift, exits 0.
#     Use for deliberate branch work.

set -euo pipefail

WEB_REPO="$(cd "$(dirname "$0")/.." && pwd)"

# Try candidate sibling paths in order; first with a convex/ directory wins.
MOBILE_REPO=""
for candidate in \
  "${OTOPAIR_MOBILE_REPO:-}" \
  "$HOME/Downloads/otopair" \
  "$(dirname "$WEB_REPO")/otopair"; do
  if [ -n "$candidate" ] && [ -d "$candidate/convex" ]; then
    MOBILE_REPO="$candidate"
    break
  fi
done

if [ -z "$MOBILE_REPO" ]; then
  cat >&2 <<EOF
warning: check-convex-drift found no otopair mobile checkout; drift NOT checked.
         set OTOPAIR_MOBILE_REPO=/path/to/otopair to enable it.
EOF
  exit 0
fi

DIFF_OUTPUT="$(diff -rq --exclude=_generated "$MOBILE_REPO/convex" "$WEB_REPO/convex" || true)"

if [ -z "$DIFF_OUTPUT" ]; then
  echo "check-convex-drift: OK — mobile ($MOBILE_REPO) and web trees agree."
  exit 0
fi

echo "check-convex-drift: DRIFT DETECTED between otopair (mobile) and otopair-web." >&2
echo "                    mobile: $MOBILE_REPO" >&2
echo "                    web:    $WEB_REPO" >&2
echo "" >&2
echo "$DIFF_OUTPUT" >&2

if [ "${OTOPAIR_ALLOW_CONVEX_DRIFT:-0}" = "1" ]; then
  echo "" >&2
  echo "OTOPAIR_ALLOW_CONVEX_DRIFT=1 set — proceeding anyway (deliberate branch work)." >&2
  exit 0
fi

echo "" >&2
echo "Refusing to proceed. Reconcile the trees first — whichever is behind" >&2
echo "syncs before the ahead one pushes. See" >&2
echo "  feedback_otopair_canonical_mobile.md in Ahmad's memory" >&2
echo "for the direction rule. If this is deliberate branch work, set" >&2
echo "OTOPAIR_ALLOW_CONVEX_DRIFT=1." >&2

exit 1
