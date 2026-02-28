#!/usr/bin/env bash
set -euo pipefail

SUFFIX="${1:-+sg1}"
DISTRIBUTION="${2:-trixie}"

if ! command -v dch >/dev/null 2>&1; then
  echo "缺少 dch，请先安装 devscripts"
  exit 1
fi

export DEBEMAIL="${DEBEMAIL:-local-builder@example.invalid}"
export DEBFULLNAME="${DEBFULLNAME:-Local Builder}"

dch --local "$SUFFIX" --distribution "$DISTRIBUTION" "Custom shell patch build"

echo "已更新 debian/changelog，本地版本后缀: $SUFFIX"
