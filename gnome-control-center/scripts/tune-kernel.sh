#!/usr/bin/env bash
set -euo pipefail

# ────────────────────────────────────────────────────────────────
# tune-kernel.sh — Kernel / system tuning for Surface GO (performance mode)
#
# Surface GO high-end: Pentium Gold 4415Y, 8GB RAM, 128GB NVMe SSD
#
# Strategy: PERFORMANCE > battery life
#   • vm.swappiness=10    — 8GB 够用，尽量不换出
#   • zram               — 压缩交换在内存中完成，避免 SSD 写入
#   • i915 performance   — 不省电，要流畅
#   • 保留 Debian 默认 swap 分区 — 作为 zram 的后备
#
# Usage:
#   sudo ./tune-kernel.sh           # apply
#   sudo ./tune-kernel.sh --status  # show current values
# ────────────────────────────────────────────────────────────────

if [ "${1:-}" = "--status" ]; then
  echo "=== 当前内核参数 ==="
  echo "vm.swappiness       = $(cat /proc/sys/vm/swappiness)"
  echo "vm.vfs_cache_pressure= $(cat /proc/sys/vm/vfs_cache_pressure)"
  echo "vm.dirty_ratio      = $(cat /proc/sys/vm/dirty_ratio)"
  echo "vm.dirty_background_ratio = $(cat /proc/sys/vm/dirty_background_ratio)"
  echo ""
  echo "=== Swap 设备 ==="
  swapon --show
  echo ""
  echo "=== zram 设备 ==="
  zramctl 2>/dev/null || echo "(zramctl not found)"
  echo ""
  echo "=== i915 参数 ==="
  for p in /sys/module/i915/parameters/{enable_fbc,enable_psr,enable_dc}; do
    [ -f "$p" ] && echo "  $(basename $p) = $(cat $p)"
  done
  exit 0
fi

echo "=== 1. VM 参数 ==="

# swappiness=10: 8GB RAM 足够，仅在内存压力很大时才换出
# 默认 60 太激进，Surface GO 更需要让热数据留在 RAM
cat > /etc/sysctl.d/90-surfacego-performance.conf <<'EOF'
# Surface GO performance tuning
vm.swappiness = 10
vm.vfs_cache_pressure = 50
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5
EOF
sysctl --system > /dev/null

echo "  vm.swappiness=10, vfs_cache_pressure=50"
echo "  dirty_ratio=15, dirty_background_ratio=5"

echo ""
echo "=== 2. zram (内存压缩交换，替代 swap 分区) ==="

# 8GB RAM + 4GB zram ≈ 12GB 等效内存，不需要 SSD swap 分区
# zram 延迟 ~微秒 vs SSD swap ~毫秒，快 1000 倍
# 装系统时不建 swap 分区，省 6.2GB SSD 空间

# 安装 zram-tools（如果没有）
if ! command -v zramctl &>/dev/null; then
  apt-get install -y zram-tools
fi

# 配置 zram: 4GB (RAM 的 50%)，zstd 压缩
cat > /etc/default/zramswap <<'EOF'
# Surface GO zram config — no swap partition needed
ALGO=zstd
PERCENT=50
PRIORITY=100
EOF

# 如果 zramswap 服务存在就重启
if systemctl list-unit-files | grep -q zramswap; then
  systemctl enable zramswap
  systemctl restart zramswap
  echo "  zram 已配置: 4GB zstd, priority=100"
elif systemctl list-unit-files | grep -q 'systemd-zram-setup'; then
  systemctl enable --now systemd-zram-setup@zram0.service
  echo "  systemd-zram 已启用: zram0"
else
  # 手动创建
  modprobe zram num_devices=1
  echo zstd > /sys/block/zram0/comp_algorithm 2>/dev/null || echo lz4 > /sys/block/zram0/comp_algorithm
  echo $((4 * 1024 * 1024 * 1024)) > /sys/block/zram0/disksize
  mkswap /dev/zram0
  swapon -p 100 /dev/zram0
  echo "  zram0 已手动创建: 4GB, priority=100"
fi

# 如果系统存在 swap 分区，关掉它
if swapon --show | grep -q 'partition'; then
  echo "  检测到 swap 分区，正在关闭..."
  swapoff -a
  swapon /dev/zram0 2>/dev/null || true
  # 注释掉 fstab 中的 swap 行防止重启恢复
  sed -i '/\sswap\s/s/^/#/' /etc/fstab
  echo "  swap 分区已关闭，fstab 已注释"
fi

echo "  8GB RAM + 4GB zram = 等效 12GB，无需 SSD swap"

echo ""
echo "=== 3. i915 显卡参数 (性能优先) ==="

# Surface GO 用 Intel HD Graphics 615 (Kaby Lake)
# enable_fbc=1: 帧缓冲压缩 — 减少显存带宽，对性能有正面帮助
# enable_psr=0: 面板自刷新 — 关闭，避免闪屏/延迟问题
# enable_dc=0:  显示核心省电 — 关闭，保证渲染流畅
cat > /etc/modprobe.d/i915-surfacego.conf <<'EOF'
# Surface GO i915: performance over power saving
options i915 enable_fbc=1 enable_psr=0 enable_dc=0
EOF

echo "  enable_fbc=1 (帧缓冲压缩, 正面性能)"
echo "  enable_psr=0 (关闭面板自刷新, 避免闪屏)"
echo "  enable_dc=0  (关闭显示省电, 保证流畅)"
echo "  → 需要重启生效"

echo ""
echo "=== 4. I/O 调度器 ==="

# SSD 默认使用 mq-deadline 或 none，确认一下
SCHED=$(cat /sys/block/sda/queue/scheduler 2>/dev/null || cat /sys/block/nvme0n1/queue/scheduler 2>/dev/null || echo "unknown")
echo "  当前 I/O 调度器: $SCHED"
echo "  (SSD 推荐 mq-deadline 或 none，通常 Debian 默认已正确)"

echo ""
echo "=== 完成 ==="
echo "部分更改需要重启生效 (i915 参数)。"
echo "运行 '$0 --status' 查看当前状态。"
