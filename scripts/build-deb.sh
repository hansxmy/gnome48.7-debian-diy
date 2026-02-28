#!/usr/bin/env bash
set -euo pipefail

# 可通过环境变量覆盖
# 示例：GNOME_SHELL_DSC_URL=https://deb.debian.org/debian/pool/main/g/gnome-shell/gnome-shell_48.7-0+deb13u1.dsc
DSC_URL="${GNOME_SHELL_DSC_URL:-https://deb.debian.org/debian/pool/main/g/gnome-shell/gnome-shell_48.7-0+deb13u1.dsc}"
LOCAL_SUFFIX="${LOCAL_SUFFIX:-+dock1}"
DISTRO="${DISTRO:-trixie}"
RUN_TESTS="${RUN_TESTS:-1}"

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
cp -f "$ROOT_DIR/overrides/js/ui/panel.js" js/ui/panel.js
cp -f "$ROOT_DIR/overrides/js/ui/clipboardIndicator.js" js/ui/clipboardIndicator.js
cp -f "$ROOT_DIR/overrides/js/ui/clipboardKeyboard.js" js/ui/clipboardKeyboard.js
cp -f "$ROOT_DIR/overrides/js/ui/clipboardSync.js" js/ui/clipboardSync.js
cp -f "$ROOT_DIR/overrides/js/ui/clipboardRegistry.js" js/ui/clipboardRegistry.js
cp -f "$ROOT_DIR/overrides/js/ui-root/main.js" js/ui/main.js
cp -f "$ROOT_DIR/overrides/js/ui-root/windowManager.js" js/ui/windowManager.js

# Patch keyboard.js: add null check for actor in maybeHandleEvent
# 修复 keyboard.js Clutter.Actor.contains: assertion 'descendant != NULL' failed
# get_event_actor() 挂起恢复后可能返回 null，导致 contains() 断言崩溃
python3 - <<'EOF'
import re
path = 'js/ui/keyboard.js'
content = open(path).read()
target = '        const actor = global.stage.get_event_actor(event);'
guard  = '        if (!actor)\n            return false;\n'
if target in content and guard not in content:
    content = content.replace(target, target + '\n' + guard, 1)
    open(path, 'w').write(content)
    print('keyboard.js: null actor guard applied')
else:
    print('keyboard.js: patch already applied or target not found')
EOF

export DEBEMAIL="${DEBEMAIL:-dock-builder@example.invalid}"
export DEBFULLNAME="${DEBFULLNAME:-Dock Builder}"
dch --local "$LOCAL_SUFFIX" --distribution "$DISTRO" "Dock custom build"

mk-build-deps --install --remove \
  --tool 'apt-get --no-install-recommends -y' \
  debian/control

if [ "$RUN_TESTS" = "1" ]; then
  echo "RUN_TESTS=1，执行完整测试构建（先过测试再产包）。"
else
  echo "RUN_TESTS=0，按需跳过测试。"
  export DEB_BUILD_OPTIONS="${DEB_BUILD_OPTIONS:-nocheck}"
fi

dpkg-buildpackage -b -uc -us

mkdir -p "$ROOT_DIR/dist"
cp -v ../*.deb "$ROOT_DIR/dist/"
cp -v ../*.changes "$ROOT_DIR/dist/" || true
cp -v ../*.buildinfo "$ROOT_DIR/dist/" || true

echo "构建完成，产物在: $ROOT_DIR/dist"
