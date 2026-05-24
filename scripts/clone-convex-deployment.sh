#!/usr/bin/env bash
#
# clone-convex-deployment.sh  (otopair-web edition)
#
# Produce a 1:1 clone (schema + functions + data + file storage) of a Convex
# dev deployment into another Convex dev deployment.
#
# Why this lives in otopair-web (not otopair mobile):
#   - convex/ here is the source of truth
#   - convex/lib/email_provider.ts imports ../../email/send which only exists here
#
# Why we swap .env.local in place (instead of using --env-file in tmp/):
#   - The Convex CLI's bundler anchors module resolution to the env file's
#     directory. If the env file is in tmp/, imports like ../../email/send
#     get resolved relative to tmp/ and fail.
#   - Swapping .env.local in place keeps the bundler's resolution identical
#     to a normal `npx convex dev` invocation. A trap restores it on exit.
#
# Why we use `convex dev --once` instead of `convex deploy` for the code push:
#   - `convex deploy` targets PRODUCTION by default and requires
#     CONVEX_DEPLOY_KEY. It does not push code to a dev deployment.
#   - `convex dev --once` runs the dev push (codegen + bundle + push) once
#     and exits.
#
# The target deployment MUST already exist. Create one with `npx convex dev
# --configure new` on the destination branch (or via the dashboard), then
# pass its name as --target.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO/.env.local"

SOURCE_DEPLOYMENT="dev:ardent-crab-641"
TARGET_DEPLOYMENT="dev:third-bird-914"
AUTO_YES=0
KEEP_DUMP=0

usage() {
  cat <<EOF
Usage: $(basename "$0") --target <deployment> [options]

Required:
  --target <name>      Target Convex dev deployment (e.g. dev:third-bird-914)

Options:
  --source <name>      Source deployment (default: CONVEX_DEPLOYMENT from .env.local)
  -y, --yes            Skip the destructive-action confirmation prompt
  --keep-dump          Keep the exported snapshot zip after import
  -h, --help           Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)     TARGET_DEPLOYMENT="$2"; shift 2 ;;
    --source)     SOURCE_DEPLOYMENT="$2"; shift 2 ;;
    -y|--yes)     AUTO_YES=1; shift ;;
    --keep-dump)  KEEP_DUMP=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$TARGET_DEPLOYMENT" ]]; then
  echo "ERROR: --target is required" >&2
  usage
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found." >&2
  exit 1
fi

# Resolve source from .env.local if not passed
if [[ -z "$SOURCE_DEPLOYMENT" ]]; then
  SOURCE_DEPLOYMENT="$(grep -E '^CONVEX_DEPLOYMENT=' "$ENV_FILE" | head -1 | cut -d= -f2 | awk '{print $1}')"
fi

if [[ -z "$SOURCE_DEPLOYMENT" ]]; then
  echo "ERROR: could not determine source deployment. Pass --source or set CONVEX_DEPLOYMENT in $ENV_FILE." >&2
  exit 1
fi

if [[ "$SOURCE_DEPLOYMENT" == "$TARGET_DEPLOYMENT" ]]; then
  echo "ERROR: source and target are the same ($SOURCE_DEPLOYMENT). Refusing to run." >&2
  exit 1
fi

cd "$REPO"

if [[ ! -f "$REPO/convex/schema.ts" ]]; then
  echo "ERROR: $REPO/convex/schema.ts not found — is this really otopair-web?" >&2
  exit 1
fi
if [[ ! -f "$REPO/email/send.ts" ]]; then
  echo "WARN: $REPO/email/send.ts missing — convex/lib/email_provider.ts will fail to bundle." >&2
fi

cat <<EOF

=== Convex Deployment Clone ===
  Source: $SOURCE_DEPLOYMENT
  Target: $TARGET_DEPLOYMENT  (will be REPLACED — all rows wiped)
  Repo:   $REPO
EOF

if [[ $AUTO_YES -ne 1 ]]; then
  echo ""
  read -r -p "Type the target deployment name to confirm DESTRUCTIVE replace: " CONFIRM
  if [[ "$CONFIRM" != "$TARGET_DEPLOYMENT" ]]; then
    echo "Confirmation mismatch. Aborting." >&2
    exit 1
  fi
fi

# --- backup .env.local + cleanup trap --------------------------------------
TMP_DIR="$REPO/tmp"
mkdir -p "$TMP_DIR"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ENV_BACKUP="$TMP_DIR/.env.local.backup-${TIMESTAMP}"
DUMP_PATH="$TMP_DIR/convex-clone-${TIMESTAMP}.zip"

cp "$ENV_FILE" "$ENV_BACKUP"
echo "Backed up $ENV_FILE -> $ENV_BACKUP"

restore_env() {
  if [[ -f "$ENV_BACKUP" ]]; then
    cp "$ENV_BACKUP" "$ENV_FILE"
    rm -f "$ENV_BACKUP"
    echo "Restored $ENV_FILE from backup."
  fi
  if [[ $KEEP_DUMP -ne 1 ]] && [[ -f "$DUMP_PATH" ]]; then
    rm -f "$DUMP_PATH"
  fi
}
trap restore_env EXIT

set_deployment_in_env() {
  local dep="$1"
  # Replace existing CONVEX_DEPLOYMENT line (or append if missing).
  if grep -qE '^CONVEX_DEPLOYMENT=' "$ENV_FILE"; then
    # Use a portable in-place sed (works on macOS BSD sed and GNU sed).
    sed -i.bak -E "s|^CONVEX_DEPLOYMENT=.*|CONVEX_DEPLOYMENT=${dep}|" "$ENV_FILE"
    rm -f "${ENV_FILE}.bak"
  else
    printf '\nCONVEX_DEPLOYMENT=%s\n' "$dep" >> "$ENV_FILE"
  fi
}

# --- Step 1: export source -------------------------------------------------
echo ""
echo "[1/3] Pointing .env.local at $SOURCE_DEPLOYMENT and exporting..."
set_deployment_in_env "$SOURCE_DEPLOYMENT"
npx convex export \
  --path "$DUMP_PATH" \
  --include-file-storage

if [[ ! -s "$DUMP_PATH" ]]; then
  echo "ERROR: export produced an empty file at $DUMP_PATH" >&2
  exit 1
fi
echo "      Export size: $(du -h "$DUMP_PATH" | awk '{print $1}')"

# --- Step 2: push code to target (schema + functions) ----------------------
echo ""
echo "[2/3] Pointing .env.local at $TARGET_DEPLOYMENT and running 'convex dev --once'..."
set_deployment_in_env "$TARGET_DEPLOYMENT"
npx convex dev --once --typecheck=disable

# --- Step 3: import data into target ---------------------------------------
echo ""
echo "[3/3] Importing snapshot into $TARGET_DEPLOYMENT (--replace-all)..."
# .env.local is still pointing at target from step 2.
npx convex import \
  --replace-all \
  --yes \
  "$DUMP_PATH"

echo ""
if [[ $KEEP_DUMP -eq 1 ]]; then
  echo "Keeping snapshot at $DUMP_PATH (--keep-dump set)."
else
  echo "Snapshot $DUMP_PATH will be removed by trap."
fi

cat <<EOF

=== Done ===
Cloned $SOURCE_DEPLOYMENT -> $TARGET_DEPLOYMENT.

Reminders:
  - Convex env vars / secrets were NOT copied. Set them on $TARGET_DEPLOYMENT
    via dashboard or:
      (with .env.local temporarily pointed at target) npx convex env set KEY value
    Common ones: RESEND_KEY, ANTHROPIC_API_KEY, FIRECRAWL_API_KEY,
    CLERK_*, TELNYX_*, SMARTCAR_*.
  - Clerk JWT issuer config carries over (convex/auth.config.ts), but if Clerk
    allowlists origins, add the new deployment URL.
  - Cron jobs are recreated by the code push, but in-flight scheduled jobs
    from source are NOT migrated.
EOF
