#!/usr/bin/env bash
# Usage: deploy.sh <env> [--dry-run]
set -euo pipefail
echo "deploying to $1 ${2:-}"
