#!/usr/bin/env bash
set -euo pipefail

# 可通过环境变量覆盖
# 示例：GNOME_SHELL_DSC_URL=https://deb.debian.org/debian/pool/main/g/gnome-shell/gnome-shell_48.7-0+deb13u1.dsc
DSC_URL="${GNOME_SHELL_DSC_URL:-https://deb.debian.org/debian/pool/main/g/gnome-shell/gnome-shell_48.7-0+deb13u1.dsc}"
LOCAL_SUFFIX="${LOCAL_SUFFIX:-+dock1}"
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
rm -rf gnome-shell-* *.dsc *.debian.tar.* *.orig.tar.*

dget -u "$DSC_URL"

SRC_DIR="$(find . -maxdepth 1 -type d -name 'gnome-shell-*' | head -n1)"
if [ -z "$SRC_DIR" ]; then
  echo "未找到解包后的 gnome-shell 源码目录"
  exit 1
fi

cd "$SRC_DIR"

# 覆盖我们定制的源码文件
cp -f "$ROOT_DIR/overrides/js/ui/overview.js" js/ui/overview.js
cp -f "$ROOT_DIR/overrides/js/ui/overviewControls.js" js/ui/overviewControls.js
cp -f "$ROOT_DIR/overrides/js/ui/dash.js" js/ui/dash.js
cp -f "$ROOT_DIR/overrides/js/ui-root/main.js" js/ui/main.js
cp -f "$ROOT_DIR/overrides/js/ui-root/windowManager.js" js/ui/windowManager.js

export DEBEMAIL="${DEBEMAIL:-dock-builder@example.invalid}"
export DEBFULLNAME="${DEBFULLNAME:-Dock Builder}"
dch --local "$LOCAL_SUFFIX" --distribution "$DISTRO" "Dock custom build"

mk-build-deps --install --remove \
  --tool 'apt-get --no-install-recommends -y' \
  debian/control

if [ "$RUN_TESTS" = "1" ]; then
  echo "RUN_TESTS=1，执行完整测试构建。"
else
  echo "RUN_TESTS=0，默认跳过测试以保证 CI 稳定产包。"
  export DEB_BUILD_OPTIONS="${DEB_BUILD_OPTIONS:-nocheck}"
fi

dpkg-buildpackage -b -uc -us

mkdir -p "$ROOT_DIR/dist"
cp -v ../*.deb "$ROOT_DIR/dist/"
cp -v ../*.changes "$ROOT_DIR/dist/" || true
cp -v ../*.buildinfo "$ROOT_DIR/dist/" || true

echo "构建完成，产物在: $ROOT_DIR/dist"
