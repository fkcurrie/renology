#!/usr/bin/env bash
# deploy_cloud_run.sh - One-command deployment for Renology Cloud Relay on Google Cloud Run
set -euo pipefail

PROJECT_ID="${GCP_PROJECT:-solaria-solar}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-renology}"
DOMAIN="${CUSTOM_DOMAIN:-solar.sfle.ca}"

echo "========================================================"
echo "  Deploying Renology Solar Cloud Relay to Cloud Run"
echo "========================================================"
echo " Project:  ${PROJECT_ID}"
echo " Region:   ${REGION}"
echo " Service:  ${SERVICE_NAME}"
echo " Domain:   ${DOMAIN}"
echo "========================================================"

# Generate or read persistent sync token
TOKEN_FILE="${HOME}/.config/renology/cloud_token.txt"
mkdir -p "$(dirname "${TOKEN_FILE}")"
if [[ -f "${TOKEN_FILE}" ]]; then
    SYNC_TOKEN=$(cat "${TOKEN_FILE}")
else
    SYNC_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)
    echo "${SYNC_TOKEN}" > "${TOKEN_FILE}"
    chmod 600 "${TOKEN_FILE}"
    echo "Generated new sync token: ${SYNC_TOKEN}"
fi

# Ensure project exists and is active
if ! gcloud projects describe "${PROJECT_ID}" &>/dev/null; then
    echo "Creating Google Cloud project: ${PROJECT_ID}..."
    gcloud projects create "${PROJECT_ID}" --name="Renology Solar Monitoring"
fi
gcloud config set project "${PROJECT_ID}"

# Enable necessary Google Cloud APIs
echo "Enabling Cloud Run and Cloud Build APIs..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

# Build container image with Cloud Build and Dockerfile
IMAGE_NAME="${REGION}-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/${SERVICE_NAME}:latest"
echo "Submitting build to Google Cloud Build using Dockerfile..."
gcloud builds submit --tag "${IMAGE_NAME}" . --project "${PROJECT_ID}"

# Deploy container image to Cloud Run
echo "Deploying to Google Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
    --image "${IMAGE_NAME}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --allow-unauthenticated \
    --set-env-vars RENOLOGY_CLOUD_TOKEN="${SYNC_TOKEN}" \
    --memory 256Mi \
    --cpu 1 \
    --min-instances 0 \
    --max-instances 2

# Retrieve deployed Service URL
CLOUD_RUN_URL=$(gcloud run services describe "${SERVICE_NAME}" --region "${REGION}" --format='value(status.url)')
echo ""
echo "========================================================"
echo "  Cloud Run Deployment Successful!"
echo "  Default URL: ${CLOUD_RUN_URL}"
echo "========================================================"

# Attempt custom domain mapping
echo ""
echo "Mapping custom domain: ${DOMAIN}..."
if gcloud beta run domain-mappings create --service "${SERVICE_NAME}" --domain "${DOMAIN}" --region "${REGION}" 2>/dev/null; then
    echo "Custom domain mapped successfully!"
else
    echo "Domain mapping already exists or requires DNS verification."
    echo "Run 'gcloud beta run domain-mappings describe --domain ${DOMAIN} --region ${REGION}' for DNS records."
fi

echo ""
echo "========================================================"
echo "  Edge Configuration (on the physical Surface Go 2):"
echo "========================================================"
echo "Add the following flags to your renology systemd service or command line:"
echo "  -cloud-url ${CLOUD_RUN_URL}"
echo "  -cloud-token ${SYNC_TOKEN}"
echo ""
echo "Or configure your custom domain once DNS resolves:"
echo "  -cloud-url https://${DOMAIN}"
echo "========================================================"
