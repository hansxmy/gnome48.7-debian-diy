#!/usr/bin/env bash
set -euo pipefail

# ────────────────────────────────────────────────────────────────
# build.sh — Build customised gnome-control-center .deb
#
# Overlay approach (same as gnome-shell build-deb.sh):
#   1. Download upstream Debian source via dget
#   2. Copy our modified files on top
#   3. Bump version with +surfacego suffix
#   4. Build binary-only packages
#
# Modifications vs upstream 48.4:
#   • Wacom panel removed      (no digitiser on Surface GO)
#   • Online Accounts removed  (unused)
#   • Printers panel removed   (no printer)
#   • Multitasking workspace settings hidden (single workspace)
#   • About page: log download button added
#   • debian/control: stripped unused GOA/wacom/cups deps
# ────────────────────────────────────────────────────────────────

DSC_URL="${GCC_DSC_URL:-https://deb.debian.org/debian/pool/main/g/gnome-control-center/gnome-control-center_48.4-1~deb13u1.dsc}"
LOCAL_SUFFIX="${LOCAL_SUFFIX:-+surfacego1}"
DISTRO="${DISTRO:-trixie}"
RUN_TESTS="${RUN_TESTS:-0}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$ROOT_DIR/work"

mkdir -p "$WORK_DIR"

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates \
  wget \
  devscripts \
  equivs \
  fakeroot \
  dpkg-dev \
  debhelper \
  build-essential \
  pkgconf

cd "$WORK_DIR"
rm -rf gnome-control-center-* *.dsc *.debian.tar.* *.orig.tar.*

dget -u "$DSC_URL"

SRC_DIR="$(find . -maxdepth 1 -type d -name 'gnome-control-center-*' | head -n1)"
if [ -z "$SRC_DIR" ]; then
  echo "ERROR: 未找到解包后的 gnome-control-center 源码目录"
  exit 1
fi

cd "$SRC_DIR"

# ── Overlay our modified files ──────────────────────────────────
OVERLAY_DIR="$ROOT_DIR/overrides"
echo "=== Applying Surface GO overlays ==="

OVERLAY_FILES=(
  "meson.build"
  "debian/control"
  "panels/meson.build"
  "panels/multitasking/cc-multitasking-panel.ui"
  "panels/system/about/cc-about-page.ui"
  "panels/system/about/cc-about-page.c"
  "shell/cc-panel-loader.c"
  "shell/cc-panel-list.c"
  "shell/meson.build"
  "tests/meson.build"
)

for f in "${OVERLAY_FILES[@]}"; do
  if [ -f "$OVERLAY_DIR/$f" ]; then
    cp -f "$OVERLAY_DIR/$f" "$f"
    echo "  ✓ $f"
  else
    echo "  ✗ MISSING: $OVERLAY_DIR/$f"
    exit 1
  fi
done

# ── Bump version ────────────────────────────────────────────────
export DEBEMAIL="${DEBEMAIL:-surfacego-builder@example.invalid}"
export DEBFULLNAME="${DEBFULLNAME:-Surface GO Builder}"

echo ""
echo "=== Bumping version ==="
dch --local "$LOCAL_SUFFIX" --distribution "$DISTRO" \
  "Surface GO customisation: remove Wacom/Online-Accounts/Printers panels, hide workspace settings, add log download"

# ── Install build deps ──────────────────────────────────────────
echo ""
echo "=== Installing build dependencies ==="
mk-build-deps --install --remove \
  --tool 'apt-get --no-install-recommends -y' \
  debian/control

# ── Build ───────────────────────────────────────────────────────
if [ "$RUN_TESTS" = "1" ]; then
  echo "RUN_TESTS=1 — running tests before packaging."
else
  echo "RUN_TESTS=0 — skipping tests."
  export DEB_BUILD_OPTIONS="${DEB_BUILD_OPTIONS:-nocheck}"
fi

echo ""
echo "=== Building gnome-control-center ==="
dpkg-buildpackage -b -uc -us -j"$(nproc)"

# ── Collect artifacts ───────────────────────────────────────────
mkdir -p "$ROOT_DIR/dist"
cp -v ../gnome-control-center*.deb "$ROOT_DIR/dist/"
cp -v ../*.changes "$ROOT_DIR/dist/" 2>/dev/null || true
cp -v ../*.buildinfo "$ROOT_DIR/dist/" 2>/dev/null || true

echo ""
echo "=== Build complete ==="
ls -lh "$ROOT_DIR/dist/"
echo ""
echo "Install:  sudo dpkg -i dist/gnome-control-center_*+surfacego*.deb"
echo "Pin:      sudo apt-mark hold gnome-control-center"
