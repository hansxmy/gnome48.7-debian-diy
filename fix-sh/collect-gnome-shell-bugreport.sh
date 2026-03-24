#!/usr/bin/env bash
set -euo pipefail

OUTDIR="${1:-$PWD/gnome-shell-bugreport-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUTDIR"

PACKAGES=(
  gnome-shell
  gnome-shell-common
  mutter
  mutter-common
)

echo "[1/7] 基础信息..."
{
  echo "timestamp=$(date -Is)"
  echo "hostname=$(hostname)"
  echo "kernel=$(uname -a)"
  echo
  cat /etc/os-release || true
  echo
  echo "gnome-shell-version=$(gnome-shell --version 2>/dev/null || true)"
  echo "session-type=${XDG_SESSION_TYPE:-unknown}"
  echo "desktop=${XDG_CURRENT_DESKTOP:-unknown}"
} > "$OUTDIR/system.txt"

echo "[2/7] 包版本与候选源..."
{
  dpkg-query -W -f='${Package}\t${Version}\n' "${PACKAGES[@]}" 2>/dev/null || true
} > "$OUTDIR/packages.tsv"

{
  apt-cache policy "${PACKAGES[@]}" || true
} > "$OUTDIR/apt-policy.txt"

echo "[3/7] GNOME/Mutter 关键设置..."
{
  echo "dynamic-workspaces=$(gsettings get org.gnome.mutter dynamic-workspaces 2>/dev/null || echo N/A)"
  echo "num-workspaces=$(gsettings get org.gnome.desktop.wm.preferences num-workspaces 2>/dev/null || echo N/A)"
  echo "enable-animations=$(gsettings get org.gnome.desktop.interface enable-animations 2>/dev/null || echo N/A)"
  echo "slow-down-factor=$(gsettings get org.gnome.mutter slow-down-factor 2>/dev/null || echo N/A)"
} > "$OUTDIR/gsettings.txt"

echo "[4/7] 当前启动日志 (最近 5000 行)..."
journalctl -b --no-pager -n 5000 > "$OUTDIR/journal-boot.log" || true
journalctl -b _COMM=gnome-shell --no-pager -n 5000 > "$OUTDIR/journal-gnome-shell.log" || true
journalctl -b -u gdm --no-pager -n 5000 > "$OUTDIR/journal-gdm.log" || true
journalctl -b -p warning..alert --no-pager -n 5000 > "$OUTDIR/journal-warn.log" || true

echo "[5/7] 组件分类日志..."
GNOME_LOG="$OUTDIR/journal-gnome-shell.log"
if [ -f "$GNOME_LOG" ]; then
  grep -iE 'clipboard|ClipboardIndicator|ClipboardSync|ClipboardRegistry' \
    "$GNOME_LOG" > "$OUTDIR/component-clipboard.log" 2>/dev/null || true
  grep -iE 'sni|StatusNotifier|tray|SNITray|SNIItem|SNIWatcher' \
    "$GNOME_LOG" > "$OUTDIR/component-sni-tray.log" 2>/dev/null || true
  grep -iE 'mountlink|MountLink|lan.mouse|lan-mouse' \
    "$GNOME_LOG" > "$OUTDIR/component-mountlink.log" 2>/dev/null || true
  grep -iE '_pages\[|_dragActor|iconGrid|IconGrid|appDisplay|AppDisplay' \
    "$GNOME_LOG" > "$OUTDIR/component-appgrid.log" 2>/dev/null || true
  grep -iE 'overview|persistentDash|ControlsManager|overviewControls' \
    "$GNOME_LOG" > "$OUTDIR/component-overview.log" 2>/dev/null || true
  find "$OUTDIR" -name 'component-*.log' -empty -delete 2>/dev/null || true
fi

echo "[6/7] coredump 与会话状态..."
coredumpctl list gnome-shell --no-pager > "$OUTDIR/coredump-list.txt" || true
if [ -n "${XDG_SESSION_ID:-}" ]; then
  loginctl session-status "$XDG_SESSION_ID" > "$OUTDIR/session-status.txt" || true
fi

echo "[7/7] 打包归档..."
ARCHIVE="${OUTDIR}.tar.gz"
tar -C "$(dirname "$OUTDIR")" -czf "$ARCHIVE" "$(basename "$OUTDIR")"

echo "已生成: $ARCHIVE"
