#!/usr/bin/env bash
set -euo pipefail

OUTDIR="${1:-$PWD/gnome-shell-bugreport-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUTDIR"

PACKAGES=(
  gnome-shell
  gnome-shell-common
  gnome-shell-extension-prefs
  mutter
  mutter-common
)

echo "[1/6] 基础信息..."
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

echo "[2/6] 包版本与候选源..."
{
  dpkg-query -W -f='${Package}\t${Version}\n' "${PACKAGES[@]}" 2>/dev/null || true
} > "$OUTDIR/packages.tsv"

{
  apt-cache policy "${PACKAGES[@]}" || true
} > "$OUTDIR/apt-policy.txt"

echo "[3/6] GNOME/Mutter 关键设置..."
{
  gsettings get org.gnome.mutter dynamic-workspaces || true
  gsettings get org.gnome.desktop.wm.preferences num-workspaces || true
  gsettings get org.gnome.desktop.interface enable-animations || true
} > "$OUTDIR/gsettings.txt"

echo "[4/6] 当前启动日志..."
journalctl -b --no-pager > "$OUTDIR/journal-boot.log" || true
journalctl -b _COMM=gnome-shell --no-pager > "$OUTDIR/journal-gnome-shell.log" || true
journalctl -b -u gdm --no-pager > "$OUTDIR/journal-gdm.log" || true
journalctl -b -p warning..alert --no-pager > "$OUTDIR/journal-warn.log" || true

echo "[5/6] coredump 与会话状态..."
coredumpctl list gnome-shell --no-pager > "$OUTDIR/coredump-list.txt" || true
if [ -n "${XDG_SESSION_ID:-}" ]; then
  loginctl session-status "$XDG_SESSION_ID" > "$OUTDIR/session-status.txt" || true
fi

echo "[6/6] 打包归档..."
ARCHIVE="${OUTDIR}.tar.gz"
tar -C "$(dirname "$OUTDIR")" -czf "$ARCHIVE" "$(basename "$OUTDIR")"

echo "已生成: $ARCHIVE"
