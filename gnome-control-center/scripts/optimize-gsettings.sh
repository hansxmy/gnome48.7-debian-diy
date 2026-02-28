#!/usr/bin/env bash
set -euo pipefail

# ────────────────────────────────────────────────────────────────
# optimize-gsettings.sh — GSettings tweaks for Surface GO performance
#
# Safe to run multiple times. All changes are per-user (dconf).
# Revert: gsettings reset <schema> <key>
#
# Usage:
#   ./optimize-gsettings.sh           # apply all
#   ./optimize-gsettings.sh --dry-run # show what would change
# ────────────────────────────────────────────────────────────────

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

apply() {
  local schema="$1" key="$2" value="$3"
  local current
  current=$(gsettings get "$schema" "$key" 2>/dev/null || echo "(not available)")
  if [ "$current" = "$value" ]; then
    echo "  [skip] $schema $key = $value (already set)"
  elif [ "$DRY_RUN" = "1" ]; then
    echo "  [dry]  $schema $key: $current → $value"
  else
    gsettings set "$schema" "$key" "$value"
    echo "  [set]  $schema $key = $value"
  fi
}

echo "=== GNOME Shell 动画优化 ==="
# 不完全关闭动画（关掉会导致部分过渡生硬），而是全局加速
# GNOME 48 没有原生速度滑块，但 mutter 有 slow-down-factor
# 0.75 = 比默认快 25%，视觉上更灵敏
apply org.gnome.desktop.interface enable-animations true
apply org.gnome.mutter.debug slow-down-factor 0.75

echo ""
echo "=== 搜索提供程序 ==="
# 禁用所有搜索提供程序 — Overview 搜索框已被移除
apply org.gnome.desktop.search-providers disable-external true
apply org.gnome.desktop.search-providers disabled "['org.gnome.Nautilus.desktop', 'org.gnome.Calculator.desktop', 'org.gnome.Characters.desktop', 'org.gnome.clocks.desktop', 'org.gnome.Contacts.desktop', 'org.gnome.Calendar.desktop', 'org.gnome.Terminal.desktop', 'org.gnome.Software.desktop', 'org.gnome.Weather.desktop']"

echo ""
echo "=== Tracker 索引 ==="
# 即使 tracker-miner-fs 被 mask，也确保 gsettings 层面关闭
# 防止意外 unmask 后立即开始全盘扫描
apply org.freedesktop.Tracker3.Miner.Files crawling-interval -2
apply org.freedesktop.Tracker3.Miner.Files enable-monitors false

echo ""
echo "=== GNOME Software 自动更新 ==="
# 禁止后台下载更新（你只用 apt）
apply org.gnome.software download-updates false
apply org.gnome.software allow-updates false
apply org.gnome.software first-run false

echo ""
echo "=== 文件管理器性能 ==="
# 关闭缩略图生成（SSD 上非必要，节省 CPU）
apply org.gnome.desktop.thumbnailers disable-all true
# 减少最近文件记录数量
apply org.gnome.desktop.privacy recent-files-max-age 7
apply org.gnome.desktop.privacy remember-recent-files true

echo ""
echo "=== 完成 ==="
if [ "$DRY_RUN" = "1" ]; then
  echo "以上为预览，实际未做任何更改。去掉 --dry-run 执行。"
else
  echo "所有 GSettings 优化已应用。注销并重新登录生效。"
fi
