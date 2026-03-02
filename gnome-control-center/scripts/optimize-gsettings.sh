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

# gsettings 操作 per-user dconf，必须以桌面用户身份运行
if [ "$(id -u)" -eq 0 ]; then
  echo "错误: 请以桌面用户身份运行（不要 sudo），否则设置只会写入 root 的 dconf" >&2
  exit 1
fi

apply() {
  local schema="$1" key="$2" value="$3"
  local current

  # 先检查 schema 是否存在，避免 gsettings set 出错导致脚本退出
  if ! gsettings list-keys "$schema" &>/dev/null; then
    echo "  [skip] $schema (schema not installed)"
    return 0
  fi

  current=$(gsettings get "$schema" "$key" 2>/dev/null || echo "(not available)")
  if [ "$current" = "(not available)" ]; then
    echo "  [skip] $schema $key (key not found)"
    return 0
  fi
  if [ "$current" = "$value" ]; then
    echo "  [skip] $schema $key = $value (already set)"
  elif [ "$DRY_RUN" = "1" ]; then
    echo "  [dry]  $schema $key: $current → $value"
  else
    if gsettings set "$schema" "$key" "$value" 2>/dev/null; then
      echo "  [set]  $schema $key = $value"
    else
      echo "  [FAIL] $schema $key — gsettings set failed"
    fi
  fi
}

echo "=== GNOME Shell 动画 ==="
# 确保动画处于开启状态（关掉会导致部分过渡生硬）
# 不调整 slow-down-factor — Surface GO 默认 1.0 即可，不需要加速
apply org.gnome.desktop.interface enable-animations true

echo ""
echo "=== 搜索提供程序 ==="
# 禁用所有搜索提供程序 — Overview 搜索框已被移除
apply org.gnome.desktop.search-providers disable-external true
apply org.gnome.desktop.search-providers disabled "['org.gnome.Nautilus.desktop', 'org.gnome.Calculator.desktop', 'org.gnome.Characters.desktop', 'org.gnome.clocks.desktop', 'org.gnome.Contacts.desktop', 'org.gnome.Calendar.desktop', 'org.gnome.Terminal.desktop', 'org.gnome.Software.desktop', 'org.gnome.Weather.desktop']"

echo ""
echo "=== Tracker / LocalSearch 索引 ==="
# 即使 tracker-miner-fs 被 mask，也确保 gsettings 层面关闭
# 防止意外 unmask 后立即开始全盘扫描
# Debian Trixie (GNOME 48) 将 Tracker3 重命名为 LocalSearch3
apply org.freedesktop.Tracker3.Miner.Files crawling-interval -2
apply org.freedesktop.Tracker3.Miner.Files enable-monitors false
apply org.freedesktop.LocalSearch3.Miner.Files crawling-interval -2
apply org.freedesktop.LocalSearch3.Miner.Files enable-monitors false

echo ""
echo "=== GNOME Software 自动更新 ==="
# 禁止后台下载更新（你只用 apt）
apply org.gnome.software download-updates false
apply org.gnome.software allow-updates false
apply org.gnome.software first-run false

echo ""
echo "=== 收藏栏清理 ==="
# Only set favorites if user hasn't customized them away from default.
# Check if current favorites still contain Nautilus (GNOME default).
_HAS_NAUTILUS=$(gsettings get org.gnome.shell favorite-apps 2>/dev/null | grep -c 'org.gnome.Nautilus' || true)
if [ "${_HAS_NAUTILUS:-0}" -gt 0 ]; then
  apply org.gnome.shell favorite-apps "['org.gnome.TextEditor.desktop', 'org.gnome.Terminal.desktop']"
else
  echo "  [skip] org.gnome.shell favorite-apps (user already customized)"
fi

echo ""
echo "=== 文件管理器性能 ==="
# 关闭缩略图生成（SSD 上非必要，节省 CPU）
apply org.gnome.desktop.thumbnailers disable-all true
# 减少最近文件记录数量
apply org.gnome.desktop.privacy recent-files-max-age 7
apply org.gnome.desktop.privacy remember-recent-files true

echo ""
echo "=== 屏幕使用时间/隐私 ==="
# 禁用 GNOME 的"使用与时间"（Screen Time）数据收集
# 这不会移除设置面板，但会停止后台统计
apply org.gnome.desktop.privacy remember-app-usage false

echo ""
echo "=== 完成 ==="
if [ "$DRY_RUN" = "1" ]; then
  echo "以上为预览，实际未做任何更改。去掉 --dry-run 执行。"
else
  echo "所有 GSettings 优化已应用。注销并重新登录生效。"
fi
