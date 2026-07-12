#!/usr/bin/env bash
# ============================================================================
# Raise Supabase auth rate limits for the Recall project.
# Run this once with a Supabase access token set in SUPABASE_ACCESS_TOKEN.
#
# Where to get the token:
#   1. Go to https://supabase.com/dashboard/account/tokens
#   2. Click "Generate new token", name it "recall-rate-limits"
#   3. Copy the value and run:
#        export SUPABASE_ACCESS_TOKEN='sbp_...'
#        bash raise-rate-limits.sh
#
# Then verify in the dashboard:
#   https://supabase.com/dashboard/project/hkjiyibpeqdoqzlyqzwz/auth/rate-limits
#
# What this does:
#   - rate_limit_email_sent:  2  -> 60  (per hour, per project)
#   - rate_limit_sign_ups:    default -> 30 (per hour, per project)
#
# Notes:
#   - rate_limit_email_sent is only configurable when using Custom SMTP
#     (your setup: Resend via the send-auth-email Edge Function). If the API
#     rejects this key, the script logs and continues.
#   - The script reads the current config first, merges the requested changes
#     on top, and PATCHes the result. Keys the API considers fixed are
#     ignored automatically.
# ============================================================================

set -euo pipefail

PROJECT_REF="hkjiyibpeqdoqzlyqzwz"
API="https://api.supabase.com/api/v1/projects/${PROJECT_REF}/config/auth"

# Desired values (per hour)
DESIRED_EMAIL_SENT=60
DESIRED_SIGN_UPS=30

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "ERROR: SUPABASE_ACCESS_TOKEN is not set." >&2
  echo "Get one at https://supabase.com/dashboard/account/tokens and re-run with:" >&2
  echo "  export SUPABASE_ACCESS_TOKEN='sbp_...'" >&2
  exit 1
fi

auth_header=(-H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" -H "Content-Type: application/json")

echo "→ Fetching current auth config for ${PROJECT_REF}…"
CURRENT=$(curl -sS "${auth_header[@]}" "${API}")

# Extract a single numeric field from the current config. Returns empty if absent.
get_num() {
  echo "$CURRENT" | grep -oE "\"$1\":[0-9]+" | head -1 | grep -oE '[0-9]+$' || true
}

CUR_EMAIL_SENT=$(get_num rate_limit_email_sent)
CUR_SIGN_UPS=$(get_num rate_limit_sign_ups)
CUR_OTP=$(get_num rate_limit_otp)
CUR_TOKEN_REFRESH=$(get_num rate_limit_token_refresh)

echo "Current values:"
echo "  rate_limit_email_sent:   ${CUR_EMAIL_SENT:-(unset)}"
echo "  rate_limit_sign_ups:     ${CUR_SIGN_UPS:-(unset)}"
echo "  rate_limit_otp:          ${CUR_OTP:-(unset)}"
echo "  rate_limit_token_refresh:${CUR_TOKEN_REFRESH:-(unset)}"
echo

# Build a patch payload containing only keys we want to change AND that
# currently exist in the config. Supabase rejects unknown keys, so we use
# the current config as the schema source of truth.
PATCH='{'
first=1
add_field() {
  local key="$1" current="$2" desired="$3"
  if [[ -z "$current" ]]; then
    echo "  (skip) $key: not present in current config — API may consider this fixed"
    return
  fi
  if [[ "$current" == "$desired" ]]; then
    echo "  (skip) $key: already at $desired"
    return
  fi
  if [[ $first -eq 0 ]]; then PATCH+=','; fi
  PATCH+="\"$key\":$desired"
  first=0
  echo "  (set)  $key: $current -> $desired"
}

echo "Patch plan:"
add_field rate_limit_email_sent "$CUR_EMAIL_SENT" "$DESIRED_EMAIL_SENT"
add_field rate_limit_sign_ups   "$CUR_SIGN_UPS"   "$DESIRED_SIGN_UPS"
PATCH+='}'

if [[ "$PATCH" == "{}" ]]; then
  echo
  echo "Nothing to change — all values already at desired levels."
  exit 0
fi

echo
echo "→ PATCH ${API}"
echo "  body: $PATCH"
echo

RESPONSE=$(curl -sS -w '\nHTTP_STATUS:%{http_code}' -X PATCH \
  "${auth_header[@]}" \
  --data "$PATCH" \
  "${API}")

HTTP_STATUS=$(echo "$RESPONSE" | tail -1 | sed 's/HTTP_STATUS://')
BODY=$(echo "$RESPONSE" | sed '$d')

echo "HTTP status: $HTTP_STATUS"
echo

if [[ "$HTTP_STATUS" == "200" ]]; then
  echo "✓ Rate limits updated. New values:"
  for key in rate_limit_email_sent rate_limit_sign_ups rate_limit_otp rate_limit_token_refresh; do
    val=$(echo "$BODY" | grep -oE "\"$key\":[0-9]+" | head -1 | grep -oE '[0-9]+$' || true)
    [[ -n "$val" ]] && echo "  $key: $val"
  done
else
  echo "✗ API call failed. Response body:"
  echo "$BODY" | head -40
  echo
  echo "If the body says 'rate_limit_email_sent is not allowed' or similar,"
  echo "the key is fixed for your plan / SMTP configuration. Set the value"
  echo "manually in Dashboard → Authentication → Rate Limits instead."
  exit 2
fi

echo
echo "Verify at:"
echo "  https://supabase.com/dashboard/project/${PROJECT_REF}/auth/rate-limits"
echo
echo "Note: any cooldown that was already in effect when you ran this will"
echo "still need to expire before the new (higher) limits let you through."
