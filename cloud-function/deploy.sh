#!/usr/bin/env bash
#
# Deploy the BigQuery AI Query Optimizer Cloud Function to your own GCP project.
#
# Usage:
#   PROJECT_ID=my-project REGION=<your-region> ./deploy.sh
#
# Or export the variables once in your shell, or edit the defaults below.
#
# Pick REGION deliberately: it is where your SQL and table schemas get
# processed, and it should normally sit close to (and under the same data
# residency rules as) the BigQuery data you query.
#
# Prerequisites — enable these APIs in the target project:
#   gcloud services enable cloudfunctions.googleapis.com \
#                          cloudbuild.googleapis.com \
#                          run.googleapis.com \
#                          artifactregistry.googleapis.com \
#                          aiplatform.googleapis.com \
#                          bigquery.googleapis.com
#
# See the README for the IAM roles the function's service account needs.

set -euo pipefail

# ── Configuration ───────────────────────────────────────────────────────

# Reads a gcloud config value, normalising the "unset" output that older
# gcloud versions print to stdout.
gcloud_cfg() {
  local v
  v="$(gcloud config get-value "$1" 2>/dev/null)"
  [[ "$v" == "(unset)" || "$v" == "None" ]] && v=""
  printf '%s' "$v"
}

# Falls back to your active gcloud project if PROJECT_ID is not set.
PROJECT_ID="${PROJECT_ID:-$(gcloud_cfg project)}"

# Region to deploy the function into. We prefer your own gcloud configuration
# over a hardcoded guess, so this only lands on us-central1 if you have not
# expressed a preference anywhere.
REGION_IS_GUESS=false
REGION="${REGION:-$(gcloud_cfg functions/region)}"
[[ -z "${REGION}" ]] && REGION="$(gcloud_cfg compute/region)"
if [[ -z "${REGION}" ]]; then
  REGION="us-central1"
  REGION_IS_GUESS=true
fi

# Where the Vertex AI calls are made. Defaults to the function's own region,
# but can be set independently — useful when the region you want to deploy
# into does not serve your chosen Gemini model. Note that this is the region
# your SQL and table schemas are processed in, so it is the one that matters
# for data residency.
VERTEX_LOCATION="${VERTEX_LOCATION:-$REGION}"

FUNCTION_NAME="${FUNCTION_NAME:-bq-query-optimizer}"
RUNTIME="${RUNTIME:-python311}"
MODEL_NAME="${MODEL_NAME:-gemini-2.5-flash-lite}"

# Queries estimated below this are flagged as "probably not worth optimizing".
DRY_RUN_THRESHOLD_GB="${DRY_RUN_THRESHOLD_GB:-250}"

# Leave empty to use the project's default compute service account.
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"

# The browser extension calls this function directly from the Cloud Console
# page, which cannot attach a Google identity token — so the function has to
# accept unauthenticated requests. Anyone who learns the URL can then invoke
# it and run up your Vertex AI bill. See "Securing the backend" in the README
# before using this in a shared or production setting.
ALLOW_UNAUTHENTICATED="${ALLOW_UNAUTHENTICATED:-true}"

# ── Validation ──────────────────────────────────────────────────────────
if [[ -z "${PROJECT_ID}" ]]; then
  echo "ERROR: PROJECT_ID is not set and no active gcloud project was found."
  echo "  Run: gcloud config set project YOUR_PROJECT_ID"
  echo "  Or:  PROJECT_ID=YOUR_PROJECT_ID ./deploy.sh"
  exit 1
fi

cd "$(dirname "$0")"

echo "Deploying Cloud Function: ${FUNCTION_NAME}"
echo "  Project:   ${PROJECT_ID}"
echo "  Region:    ${REGION}"
echo "  Vertex AI: ${VERTEX_LOCATION}"
echo "  Runtime:   ${RUNTIME}"
echo "  Model:     ${MODEL_NAME}"
echo "  Threshold: ${DRY_RUN_THRESHOLD_GB} GB"

if [[ "${REGION_IS_GUESS}" == "true" ]]; then
  echo
  echo "  WARNING: no region was set and gcloud has no default configured, so"
  echo "           this falls back to us-central1 (Iowa, USA). Your SQL and"
  echo "           table schemas would be processed there. If that is not what"
  echo "           you want, re-run with e.g. REGION=europe-west1 ./deploy.sh"
fi
echo "  Service account: ${SERVICE_ACCOUNT:-<project default compute SA>}"

if [[ -f org-context.txt ]]; then
  echo "  Org context: org-context.txt ($(wc -c < org-context.txt | tr -d ' ') bytes, bundled)"
else
  echo "  Org context: none (optional — see org-context.example.txt)"
fi

if [[ "${ALLOW_UNAUTHENTICATED}" == "true" ]]; then
  echo
  echo "  NOTE: deploying with --allow-unauthenticated. The URL will be callable"
  echo "        by anyone who has it. See 'Securing the backend' in the README."
fi
echo

# ── Build the deploy command ────────────────────────────────────────────
ENV_VARS="GCP_PROJECT=${PROJECT_ID}"
ENV_VARS+=",VERTEX_LOCATION=${VERTEX_LOCATION}"
ENV_VARS+=",MODEL_NAME=${MODEL_NAME}"
ENV_VARS+=",DRY_RUN_THRESHOLD_GB=${DRY_RUN_THRESHOLD_GB}"

DEPLOY_ARGS=(
  "${FUNCTION_NAME}"
  --gen2
  --project="${PROJECT_ID}"
  --region="${REGION}"
  --runtime="${RUNTIME}"
  --trigger-http
  --entry-point=analyze_query
  --memory=512MB
  --timeout=120s
  --min-instances=0
  --max-instances=5
  --set-env-vars="${ENV_VARS}"
  --source=.
)

if [[ -n "${SERVICE_ACCOUNT}" ]]; then
  DEPLOY_ARGS+=(--service-account="${SERVICE_ACCOUNT}")
fi

if [[ "${ALLOW_UNAUTHENTICATED}" == "true" ]]; then
  DEPLOY_ARGS+=(--allow-unauthenticated)
else
  DEPLOY_ARGS+=(--no-allow-unauthenticated)
fi

gcloud functions deploy "${DEPLOY_ARGS[@]}"

# ── Report the URL ──────────────────────────────────────────────────────
URL="$(gcloud functions describe "${FUNCTION_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --format="value(serviceConfig.uri)")"

echo
echo "Deployed. Function URL:"
echo "  ${URL}"
echo
echo "Next steps:"
echo "  1. Open the extension's Settings page (chrome://extensions -> Details -> Extension options)."
echo "  2. Paste the URL above and click Save."
echo
echo "Smoke test (free — dry run only, no Vertex AI call):"
echo "  curl -sS -X POST '${URL}' \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"query\": \"SELECT 1\", \"dry_run_only\": true}'"
