# Multi-stage production Dockerfile for Renology Cloud Relay on Google Cloud Run
FROM golang:alpine AS builder

# Install build dependencies for CGO (SQLite)
RUN apk add --no-cache gcc musl-dev

WORKDIR /src

# Cache dependencies
COPY go.mod go.sum ./
RUN go mod download

# Copy source code and embedded web assets
COPY . .

# Compile optimized static binary
RUN CGO_ENABLED=1 GOOS=linux go build -ldflags="-w -s" -o /renology main.go

# --- Minimal Runtime Image ---
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata

# Create unprivileged application user
RUN addgroup -S renology && adduser -S -G renology -u 10001 renology

WORKDIR /app
COPY --from=builder /renology /app/renology

# Create data directory with proper permissions
RUN mkdir -p /app/data && chown -R renology:renology /app

USER renology:renology

ENV PORT=8080
ENV GIN_MODE=release
EXPOSE 8080

# Cloud Run defaults: relay mode ingests edge pushes and serves kiosk UI
ENTRYPOINT ["/app/renology", "-cloud-relay", "-out", "/app/data"]
