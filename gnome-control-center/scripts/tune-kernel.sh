#!/usr/bin/env bash
set -euo pipefail

# ────────────────────────────────────────────────────────────────
# tune-kernel.sh — Kernel / system tuning for Surface GO (performance mode)
#
# Surface GO 1: Intel Pentium 4415Y, 8GB RAM, 64GB eMMC
#
# Strategy: PERFORMANCE > battery life
#   • vm.swappiness=10    — 8GB 够用，尽量不换出
#   • zram               — 压缩交换在内存中完成，避免 SSD 写入
#   • i915 performance   — 关闭 PSR 避免闪屏
#   • 保留 Debian 默认 swap 分区 — 作为 zram 的后备
#
# Usage:
#   sudo ./tune-kernel.sh           # apply
#   sudo ./tune-kernel.sh --status  # show current values
# ────────────────────────────────────────────────────────────────

# ── 权限检查 (--status 也需要读取某些 root 文件) ──
if [ "$(id -u)" -ne 0 ]; then
  echo "错误: 请使用 sudo 运行此脚本" >&2
  exit 1
fi

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
  for p in /sys/module/i915/parameters/{enable_fbc,enable_psr}; do
    [ -f "$p" ] && echo "  $(basename "$p") = $(cat "$p")"
  done
  echo ""
  echo "=== 触屏恢复服务 ==="
  if systemctl is-enabled surface-touch-resume.service 2>/dev/null; then
    echo "  surface-touch-resume.service: $(systemctl is-enabled surface-touch-resume.service 2>/dev/null)"
  else
    echo "  surface-touch-resume.service: 未安装"
  fi
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
if ! dpkg -l zram-tools 2>/dev/null | grep -q '^ii'; then
  echo "  安装 zram-tools ..."
  apt-get install -y zram-tools
fi

# 配置 zram: 4GB (RAM 的 50%)，zstd 压缩
cat > /etc/default/zramswap <<'EOF'
# Surface GO zram config — no swap partition needed
ALGO=zstd
PERCENT=50
PRIORITY=100
EOF

# 如果 zram 已经在运行，跳过重复初始化
if swapon --show=NAME,TYPE 2>/dev/null | grep -q 'zram'; then
  echo "  zram 已在运行，跳过初始化"
elif systemctl list-unit-files | grep -q zramswap; then
  systemctl enable zramswap
  systemctl restart zramswap
  echo "  zram 已配置: 4GB zstd, priority=100"
elif systemctl list-unit-files | grep -q 'systemd-zram-setup'; then
  systemctl enable --now systemd-zram-setup@zram0.service
  echo "  systemd-zram 已启用: zram0"
else
  # 手动创建 + 持久化 systemd unit
  modprobe zram num_devices=1
  # Reset any stale zram device to ensure clean state
  echo 1 > /sys/block/zram0/reset 2>/dev/null || true
  echo zstd > /sys/block/zram0/comp_algorithm 2>/dev/null || echo lz4 > /sys/block/zram0/comp_algorithm 2>/dev/null || echo "  警告: zram 不支持 zstd/lz4，使用默认 lzo-rle 算法"
  echo $((4 * 1024 * 1024 * 1024)) > /sys/block/zram0/disksize
  mkswap /dev/zram0
  swapon -p 100 /dev/zram0
  # 创建 systemd service 确保重启后自动恢复 zram
  cat > /etc/systemd/system/zram-manual.service <<'UNIT'
[Unit]
Description=Manual zram swap (Surface GO)
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=/bin/sh -c 'if [ -e /sys/block/zram0/reset ]; then swapoff /dev/zram0 2>/dev/null; echo 1 > /sys/block/zram0/reset 2>/dev/null; fi; true'
ExecStart=/bin/sh -c 'modprobe zram num_devices=1 && echo zstd > /sys/block/zram0/comp_algorithm 2>/dev/null; echo 4294967296 > /sys/block/zram0/disksize && mkswap /dev/zram0 && swapon -p 100 /dev/zram0'
ExecStop=/sbin/swapoff /dev/zram0

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable zram-manual.service
  echo "  zram0 已手动创建: 4GB, priority=100 (systemd unit 已安装，重启后自动恢复)"
fi

# 如果系统存在 swap 分区，关掉它（保留 zram）
if swapon --show | grep -q 'partition'; then
  echo "  检测到 swap 分区，正在关闭..."

  # Safety: check if swap usage is too high to safely disable
  SWAP_TOTAL=$(free -m | awk '/^Swap:/ {print $2}')
  SWAP_USED=$(free -m | awk '/^Swap:/ {print $3}')
  MEM_FREE=$(free -m | awk '/^Mem:/ {print $7}')  # available
  if [ "${SWAP_USED:-0}" -gt 0 ] && [ "${MEM_FREE:-999999}" -lt "${SWAP_USED:-0}" ]; then
    echo "  ⚠ WARNING: ${SWAP_USED}MB swap in use but only ${MEM_FREE}MB RAM available"
    echo "  Skipping swapoff to avoid OOM. Please close applications and retry."
  else
    # 仅关闭非 zram 的 swap 设备，保留 zram 运行
    swapon --show=NAME,TYPE --noheadings | while read -r name type; do
      if [ "$type" != "partition" ]; then continue; fi
      swapoff "$name" && echo "  已关闭: $name" || echo "  关闭失败: $name"
    done
    # 注释掉 fstab 中的 swap 行防止重启恢复
    cp /etc/fstab /etc/fstab.bak.$(date +%s)
    sed -i '/^[^#].*\sswap\s/s/^/#/' /etc/fstab
    echo "  swap 分区已关闭，fstab 已注释（备份: /etc/fstab.bak.*）"
  fi
fi

echo "  8GB RAM + 4GB zram = 等效 12GB，无需 SSD swap"

echo ""
echo "=== 3. i915 显卡参数 (性能优先) ==="

# Surface GO 用 Intel HD Graphics 615 (Kaby Lake)
# enable_fbc=1: 帧缓冲压缩 — 减少显存带宽，对性能有正面帮助
# enable_psr=0: 面板自刷新 — 关闭，避免闪屏/延迟问题
# enable_dc=1:  显示核心省电 — 保持默认，enable_dc=0 可能导致 GPU 挂起
if lsmod 2>/dev/null | grep -q '^i915'; then
  cat > /etc/modprobe.d/i915-surfacego.conf <<'EOF'
# Surface GO i915: performance over power saving
options i915 enable_fbc=1 enable_psr=0
EOF
  echo "  enable_fbc=1 (帧缓冲压缩, 正面性能)"
  echo "  enable_psr=0 (关闭面板自刷新, 避免闪屏)"
  echo "  enable_dc   (保持默认, 不禁用以避免GPU挂起)"
  echo "  → 需要重启生效"
else
  echo "  [skip] i915 模块未加载（非 Intel GPU 或未检测到）"
fi

echo ""
echo "=== 4. I/O 调度器 ==="

# SSD 默认使用 mq-deadline 或 none，确认一下
SCHED=$(cat /sys/block/mmcblk0/queue/scheduler 2>/dev/null || cat /sys/block/nvme0n1/queue/scheduler 2>/dev/null || cat /sys/block/sda/queue/scheduler 2>/dev/null || echo "unknown")
echo "  当前 I/O 调度器: $SCHED"
echo "  (SSD 推荐 mq-deadline 或 none，通常 Debian 默认已正确)"

echo ""
echo "=== 5. 触屏休眠恢复修复 ==="

# Surface GO 1 的 SileadTouch (MSSL1680:00) 在 sleep/resume 后
# 偶尔失联。内核 surface_aggregator 或 i2c-hid 驱动在恢复时
# 没有正确重新初始化设备。通过 systemd service 在 resume 后
# unbind + rebind i2c-hid 驱动来强制重新探测触屏。
TOUCH_I2C_DEVICE=""
for dev in /sys/bus/i2c/drivers/i2c_hid_acpi/*/name; do
  if [ -f "$dev" ] && grep -qi 'silead\|MSSL\|1680' "$dev" 2>/dev/null; then
    TOUCH_I2C_DEVICE=$(basename "$(dirname "$dev")")
    break
  fi
done

if [ -z "$TOUCH_I2C_DEVICE" ]; then
  # Fallback: try to find any i2c-hid-acpi device (Surface GO touch)
  for dev in /sys/bus/i2c/drivers/i2c_hid_acpi/*/; do
    [ -d "$dev" ] && TOUCH_I2C_DEVICE=$(basename "$dev") && break
  done
fi

if [ -n "$TOUCH_I2C_DEVICE" ]; then
  cat > /etc/systemd/system/surface-touch-resume.service <<UNIT
[Unit]
Description=Rebind Surface GO touchscreen after resume
After=suspend.target hibernate.target hybrid-sleep.target suspend-then-hibernate.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo "$TOUCH_I2C_DEVICE" > /sys/bus/i2c/drivers/i2c_hid_acpi/unbind 2>/dev/null; sleep 0.5; echo "$TOUCH_I2C_DEVICE" > /sys/bus/i2c/drivers/i2c_hid_acpi/bind 2>/dev/null; true'

[Install]
WantedBy=suspend.target hibernate.target hybrid-sleep.target suspend-then-hibernate.target
UNIT
  systemctl daemon-reload
  systemctl enable surface-touch-resume.service
  echo "  surface-touch-resume.service 已安装"
  echo "  触屏设备: $TOUCH_I2C_DEVICE"
  echo "  → 下次休眠恢复后将自动重新绑定触屏驱动"
else
  echo "  [skip] 未检测到 i2c-hid 触屏设备"
fi

echo ""
echo "=== 完成 ==="
echo "部分更改需要重启生效 (i915 参数、触屏恢复服务)。"
echo "运行 '$0 --status' 查看当前状态。"
