# ============================================================================
# raise-rate-limits.ps1 — PowerShell version
#
# Raises the auth rate limits for the Recall Supabase project.
# Run from a PowerShell window in the project folder.
#
# Usage:
#   $env:SUPABASE_ACCESS_TOKEN = "sbp_your_token_here"
#   powershell -ExecutionPolicy Bypass -File .\raise-rate-limits.ps1
#
# Get a token at: https://supabase.com/dashboard/account/tokens
# ============================================================================

$ErrorActionPreference = "Stop"

$ProjectRef = "hkjjiyibpeqdoqzlyqzwz"
$ApiBase    = "https://api.supabase.com/api/v1/projects/$ProjectRef/config/auth"
$DesiredEmailSent = 60
$DesiredSignUps   = 30

if (-not $env:SUPABASE_ACCESS_TOKEN) {
  Write-Host "ERROR: SUPABASE_ACCESS_TOKEN is not set." -ForegroundColor Red
  Write-Host "Get one at https://supabase.com/dashboard/account/tokens and re-run with:"
  Write-Host '  $env:SUPABASE_ACCESS_TOKEN = "sbp_..."'
  exit 1
}

$Headers = @{
  Authorization = "Bearer $env:SUPABASE_ACCESS_TOKEN"
  "Content-Type" = "application/json"
}

Write-Host "→ Fetching current auth config for $ProjectRef…"
try {
  $current = Invoke-RestMethod -Method Get -Uri $ApiBase -Headers $Headers
} catch {
  Write-Host "Failed to fetch current config:" -ForegroundColor Red
  Write-Host $_.Exception.Message
  exit 2
}

function Get-Num($obj, $key) {
  if ($obj.PSObject.Properties.Name -contains $key) { return $obj.$key }
  return $null
}

$curEmailSent = Get-Num $current "rate_limit_email_sent"
$curSignUps   = Get-Num $current "rate_limit_sign_ups"
$curOtp       = Get-Num $current "rate_limit_otp"
$curTokenRef  = Get-Num $current "rate_limit_token_refresh"

Write-Host "Current values:"
Write-Host "  rate_limit_email_sent:    $($curEmailSent ?? '(unset)')"
Write-Host "  rate_limit_sign_ups:      $($curSignUps   ?? '(unset)')"
Write-Host "  rate_limit_otp:           $($curOtp       ?? '(unset)')"
Write-Host "  rate_limit_token_refresh: $($curTokenRef  ?? '(unset)')"
Write-Host ""

# Build patch with only keys that exist in the current config and that we
# actually want to change. Unknown keys would cause the API to reject the
# request, so we treat the current config as the schema.
$patch = @{}
Write-Host "Patch plan:"

if ($null -eq $curEmailSent) {
  Write-Host "  (skip) rate_limit_email_sent: not present in current config — may be fixed for your plan"
} elseif ($curEmailSent -eq $DesiredEmailSent) {
  Write-Host "  (skip) rate_limit_email_sent: already at $DesiredEmailSent"
} else {
  $patch["rate_limit_email_sent"] = $DesiredEmailSent
  Write-Host "  (set)  rate_limit_email_sent: $curEmailSent -> $DesiredEmailSent"
}

if ($null -eq $curSignUps) {
  Write-Host "  (skip) rate_limit_sign_ups: not present in current config — may be fixed for your plan"
} elseif ($curSignUps -eq $DesiredSignUps) {
  Write-Host "  (skip) rate_limit_sign_ups: already at $DesiredSignUps"
} else {
  $patch["rate_limit_sign_ups"] = $DesiredSignUps
  Write-Host "  (set)  rate_limit_sign_ups: $curSignUps -> $DesiredSignUps"
}

if ($patch.Count -eq 0) {
  Write-Host ""
  Write-Host "Nothing to change — all values already at desired levels."
  exit 0
}

$body = $patch | ConvertTo-Json -Compress
Write-Host ""
Write-Host "→ PATCH $ApiBase"
Write-Host "  body: $body"
Write-Host ""

try {
  $response = Invoke-RestMethod -Method Patch -Uri $ApiBase -Headers $Headers -Body $body
  Write-Host "✓ Rate limits updated. New values:" -ForegroundColor Green
  foreach ($k in @("rate_limit_email_sent", "rate_limit_sign_ups", "rate_limit_otp", "rate_limit_token_refresh")) {
    $v = Get-Num $response $k
    if ($null -ne $v) { Write-Host "  ${k}: $v" }
  }
} catch {
  Write-Host "✗ API call failed." -ForegroundColor Red
  Write-Host $_.Exception.Message
  Write-Host ""
  Write-Host "If the error mentions an unsupported key, set the value manually at:"
  Write-Host "  https://supabase.com/dashboard/project/$ProjectRef/auth/rate-limits"
  exit 3
}

Write-Host ""
Write-Host "Verify at:"
Write-Host "  https://supabase.com/dashboard/project/$ProjectRef/auth/rate-limits"
Write-Host ""
Write-Host "Note: any cooldown that was already in effect when you ran this will"
Write-Host "still need to expire before the new (higher) limits let you through."
