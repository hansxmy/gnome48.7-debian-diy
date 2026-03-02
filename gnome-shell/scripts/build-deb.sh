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

if [ "$(id -u)" -ne 0 ]; then
  echo "错误: 此脚本需要 root 权限运行 (sudo $0)" >&2
  exit 1
fi

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
  pkgconf \
  python3

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
OVERLAY_FILES=(
  "js/ui/overview.js"
  "js/ui/overviewControls.js"
  "js/ui/dash.js"
  "js/ui/panel.js"
  "js/ui/clipboardIndicator.js"
  "js/ui/clipboardKeyboard.js"
  "js/ui/clipboardSync.js"
  "js/ui/clipboardRegistry.js"
  "js/ui/sniWatcher.js"
  "js/ui/sniItem.js"
  "js/ui/sniMenu.js"
  "js/ui/sniTray.js"
)

# ui-root files map to js/ui/ in the source tree
OVERLAY_ROOT_FILES=(
  "js/ui-root/main.js:js/ui/main.js"
  "js/ui-root/windowManager.js:js/ui/windowManager.js"
)

echo "=== Applying gnome-shell overlays ==="
for f in "${OVERLAY_FILES[@]}"; do
  src="$ROOT_DIR/overrides/$f"
  if [ ! -f "$src" ]; then
    echo "  ✗ MISSING: $src"
    exit 1
  fi
  cp -f "$src" "$f"
  echo "  ✓ $f"
done

for mapping in "${OVERLAY_ROOT_FILES[@]}"; do
  src_rel="${mapping%%:*}"
  dst_rel="${mapping##*:}"
  src="$ROOT_DIR/overrides/$src_rel"
  if [ ! -f "$src" ]; then
    echo "  ✗ MISSING: $src"
    exit 1
  fi
  cp -f "$src" "$dst_rel"
  echo "  ✓ $src_rel → $dst_rel"
done

# ── Patch GResource XML: register new JS files ──────────────────
# GNOME Shell bundles all JS into GResource at build time.
# Without this, import of clipboardIndicator.js etc. fails at runtime:
#   "Gio.IOErrorEnum: Unable to load file from: resource:///org/gnome/shell/ui/..."
# We inject our new files into the XML list so glib-compile-resources includes them.
NEW_JS_FILES=(
  clipboardIndicator.js
  clipboardKeyboard.js
  clipboardSync.js
  clipboardRegistry.js
  sniWatcher.js
  sniItem.js
  sniMenu.js
  sniTray.js
)

python3 - "${NEW_JS_FILES[@]}" <<'PYEOF'
import sys, os, glob

new_files = sys.argv[1:]

# Find the GResource XML that lists js/ui/*.js files
xml_candidates = (
    glob.glob('js/js-resources.gresource.xml*') +
    glob.glob('data/*js*gresource*xml*') +
    glob.glob('**/js-resources.gresource.xml*', recursive=True) +
    glob.glob('**/*js*gresource*xml*', recursive=True)
)

# Find the one containing "ui/panel.js"
gresource_xml = None
for path in set(xml_candidates):
    if os.path.isfile(path):
        with open(path) as f:
            if 'ui/panel.js' in f.read():
                gresource_xml = path
                break

if not gresource_xml:
    # Fallback: search all xml files
    for path in glob.glob('**/*.xml*', recursive=True):
        if os.path.isfile(path):
            try:
                with open(path) as f:
                    if 'ui/panel.js' in f.read():
                        gresource_xml = path
                        break
            except:
                pass

if not gresource_xml:
    print("ERROR: Could not find GResource XML containing ui/panel.js")
    sys.exit(1)

print(f"Found GResource XML: {gresource_xml}")

with open(gresource_xml) as f:
    content = f.read()

# Insert new file entries after the ui/panel.js line
insert_lines = '\n'.join(f'    <file>ui/{f}</file>' for f in new_files)
anchor = '<file>ui/panel.js</file>'

if anchor not in content:
    # Try with different indentation/prefix
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.endswith('ui/panel.js</file>'):
            anchor = stripped
            indent = line[:len(line) - len(line.lstrip())]
            insert_lines = '\n'.join(f'{indent}<file>ui/{f}</file>' for f in new_files)
            break

if anchor not in content:
    print("ERROR: Could not find ui/panel.js entry in GResource XML")
    sys.exit(1)

# Skip files already present
already = [f for f in new_files if f'ui/{f}</file>' in content]
to_add  = [f for f in new_files if f'ui/{f}</file>' not in content]

if already:
    print(f"  Already registered: {', '.join(already)}")

if to_add:
    # Detect indentation from anchor line
    for line in content.splitlines():
        if anchor in line:
            indent = line[:len(line) - len(line.lstrip())]
            break
    else:
        indent = '    '

    insert_block = '\n'.join(f'{indent}<file>ui/{f}</file>' for f in to_add)
    # Insert after the anchor line
    idx = content.index(anchor) + len(anchor)
    content = content[:idx] + '\n' + insert_block + content[idx:]

    with open(gresource_xml, 'w') as f:
        f.write(content)
    print(f"  Added to GResource XML: {', '.join(to_add)}")
else:
    print("  All files already registered in GResource XML")
PYEOF

# Patch keyboard.js: add null check for actor in maybeHandleEvent
# 修复 keyboard.js Clutter.Actor.contains: assertion 'descendant != NULL' failed
# get_event_actor() 挂起恢复后可能返回 null，导致 contains() 断言崩溃
python3 - <<'KBEOF'
import sys
path = 'js/ui/keyboard.js'
try:
    content = open(path).read()
except FileNotFoundError:
    print(f'keyboard.js: {path} not found — skipping (non-fatal)', file=sys.stderr)
    sys.exit(0)

target = '        const actor = global.stage.get_event_actor(event);'
guard  = '        if (!actor)\n            return false;\n'
if target in content and guard not in content:
    content = content.replace(target, target + '\n' + guard, 1)
    open(path, 'w').write(content)
    print('keyboard.js: null actor guard applied')
elif guard in content:
    print('keyboard.js: patch already applied')
elif target not in content:
    # Target line changed in newer GNOME versions — warn but don't fail build
    print('keyboard.js: target pattern not found — patch skipped (upstream may have changed)', file=sys.stderr)
KBEOF

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
  export DEB_BUILD_OPTIONS="${DEB_BUILD_OPTIONS:+$DEB_BUILD_OPTIONS }nocheck"
fi

dpkg-buildpackage -b -uc -us -j"$(nproc)"

mkdir -p "$ROOT_DIR/dist"
cp -v ../*.deb "$ROOT_DIR/dist/"
cp -v ../*.changes "$ROOT_DIR/dist/" || true
cp -v ../*.buildinfo "$ROOT_DIR/dist/" || true

# 删除不需要的 gnome-shell-extension-prefs 包
rm -fv "$ROOT_DIR/dist/gnome-shell-extension-prefs"*.deb 2>/dev/null || true

echo "构建完成，产物在: $ROOT_DIR/dist"
echo "安装命令: sudo dpkg -i dist/gnome-shell_*.deb dist/gnome-shell-common_*.deb"
