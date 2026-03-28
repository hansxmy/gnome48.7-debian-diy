#!/usr/bin/env bash
set -euo pipefail

# ────────────────────────────────────────────────────────────────
# sign-kernel.sh — 签名自定义内核 + 导入 MOK 证书
#
# Surface GO 1 Secure Boot 签名脚本
#
# 用法:
#   sudo ./sign-kernel.sh                # 签名当前运行的内核
#   sudo ./sign-kernel.sh 6.12.74surface-go-1   # 签名指定版本
#   sudo ./sign-kernel.sh --import-mok   # 仅导入 MOK 证书到 UEFI
#   sudo ./sign-kernel.sh --status       # 查看当前状态
#   sudo ./sign-kernel.sh --clean        # 删除所有 .unsigned 备份
#   sudo ./sign-kernel.sh --remove-kernel 6.x.y  # 彻底删除指定内核
#   sudo ./sign-kernel.sh --list         # 列出所有内核及占用空间
# ────────────────────────────────────────────────────────────────

SIGN_KEY="/home/xmy/kernel-signing/MOK.priv"
SIGN_CERT="/home/xmy/kernel-signing/MOK.pem"
SIGN_DER="/home/xmy/kernel-signing/MOK.der"

# ── 权限检查 ──
if [ "$(id -u)" -ne 0 ]; then
    echo "错误: 请使用 sudo 运行此脚本" >&2
    exit 1
fi

# ── 检查签名工具 ──
check_tools() {
    local missing=()
    command -v sbsign  >/dev/null 2>&1 || missing+=(sbsigntool)
    command -v mokutil >/dev/null 2>&1 || missing+=(mokutil)

    if [ ${#missing[@]} -gt 0 ]; then
        echo "正在安装缺失的工具: ${missing[*]} ..."
        apt-get update -qq
        apt-get install -y "${missing[@]}"
    fi
}

# ── 检查证书文件 ──
check_certs() {
    local ok=true
    for f in "$SIGN_KEY" "$SIGN_CERT" "$SIGN_DER"; do
        if [ ! -f "$f" ]; then
            echo "错误: 找不到 $f" >&2
            ok=false
        fi
    done
    if [ "$ok" = false ]; then
        echo ""
        echo "请先生成 MOK 证书:"
        echo "  cd /home/xmy/kernel-signing"
        echo "  openssl req -new -x509 -newkey rsa:2048 -keyout MOK.priv -outform DER -out MOK.der -nodes -days 36500 -subj '/CN=Surface GO Kernel Signing/'"
        echo "  openssl x509 -in MOK.der -inform DER -outform PEM -out MOK.pem"
        echo "  openssl x509 -in MOK.der -inform DER -outform PEM -out MOK.crt"
        exit 1
    fi
}

# ── --list: 列出所有内核及占用空间 ──
if [ "${1:-}" = "--list" ]; then
    echo "=== /boot 中的内核文件 ==="
    echo ""
    CURRENT=$(uname -r)
    # 收集所有内核版本
    for vmlinuz in /boot/vmlinuz-*; do
        [ -f "$vmlinuz" ] || continue
        kver=$(basename "$vmlinuz" | sed 's/^vmlinuz-//; s/\.unsigned$//')
    done | sort -u

    total=0
    for vmlinuz in /boot/vmlinuz-*; do
        [ -f "$vmlinuz" ] || continue
        kver=$(basename "$vmlinuz" | sed 's/^vmlinuz-//')
        base_kver=$(echo "$kver" | sed 's/\.unsigned$//')
        size=$(du -sh "$vmlinuz" 2>/dev/null | cut -f1)
        marker=""
        [ "$base_kver" = "$CURRENT" ] && marker=" ← 当前"
        echo "  $size  /boot/vmlinuz-$kver$marker"
    done

    echo ""
    echo "=== /boot 中的 initrd ==="
    for initrd in /boot/initrd.img-*; do
        [ -f "$initrd" ] || continue
        size=$(du -sh "$initrd" 2>/dev/null | cut -f1)
        echo "  $size  $initrd"
    done

    echo ""
    echo "=== /lib/modules/ ==="
    for moddir in /lib/modules/*/; do
        [ -d "$moddir" ] || continue
        kver=$(basename "$moddir")
        size=$(du -sh "$moddir" 2>/dev/null | cut -f1)
        marker=""
        [ "$kver" = "$CURRENT" ] && marker=" ← 当前"
        echo "  $size  $moddir$marker"
    done

    echo ""
    echo "=== 通过 dpkg 安装的内核包 ==="
    dpkg --list 'linux-image-*' 2>/dev/null | grep '^ii' | awk '{print "  " $2 "  " $3}' || echo "  (无)"

    echo ""
    echo "/boot 总占用: $(du -sh /boot 2>/dev/null | cut -f1)"
    echo "/lib/modules 总占用: $(du -sh /lib/modules 2>/dev/null | cut -f1)"
    exit 0
fi

# ── --clean: 删除所有 .unsigned 备份 ──
if [ "${1:-}" = "--clean" ]; then
    echo "=== 清理 .unsigned 备份文件 ==="
    found=0
    for f in /boot/vmlinuz-*.unsigned; do
        [ -f "$f" ] || continue
        size=$(du -sh "$f" 2>/dev/null | cut -f1)
        echo "  $size  $f"
        found=$((found + 1))
    done

    if [ "$found" -eq 0 ]; then
        echo "没有 .unsigned 备份文件。"
        exit 0
    fi

    echo ""
    echo "共 $found 个备份文件。"
    read -p "确认删除所有 .unsigned 备份? [y/N] " confirm
    if [ "${confirm,,}" = "y" ]; then
        rm -v /boot/vmlinuz-*.unsigned
        echo "清理完成。"
    else
        echo "取消。"
    fi
    exit 0
fi

# ── --remove-kernel VERSION: 彻底删除指定内核 ──
if [ "${1:-}" = "--remove-kernel" ]; then
    RKVER="${2:-}"
    if [ -z "$RKVER" ]; then
        echo "用法: sudo $0 --remove-kernel <版本号>" >&2
        echo ""
        echo "可用的内核:"
        for vmlinuz in /boot/vmlinuz-*; do
            [ -f "$vmlinuz" ] || continue
            kver=$(basename "$vmlinuz" | sed 's/^vmlinuz-//; s/\.unsigned$//')
            echo "  $kver"
        done | sort -u
        exit 1
    fi

    CURRENT=$(uname -r)
    if [ "$RKVER" = "$CURRENT" ]; then
        echo "错误: 不能删除正在运行的内核 ($CURRENT)" >&2
        exit 1
    fi

    echo "=== 将要删除内核: $RKVER ==="
    echo ""

    # 列出所有将删除的文件
    files=()
    for pattern in \
        "/boot/vmlinuz-${RKVER}" \
        "/boot/vmlinuz-${RKVER}.unsigned" \
        "/boot/initrd.img-${RKVER}" \
        "/boot/config-${RKVER}" \
        "/boot/System.map-${RKVER}" \
    ; do
        [ -f "$pattern" ] && files+=("$pattern")
    done

    moddir="/lib/modules/${RKVER}"
    has_moddir=false
    if [ -d "$moddir" ]; then
        has_moddir=true
    fi

    # 检查是否有 dpkg 包
    dpkg_pkg=""
    if dpkg --list "linux-image-${RKVER}" >/dev/null 2>&1; then
        dpkg_pkg="linux-image-${RKVER}"
    fi

    if [ ${#files[@]} -eq 0 ] && [ "$has_moddir" = false ] && [ -z "$dpkg_pkg" ]; then
        echo "找不到内核 $RKVER 的任何文件。"
        exit 1
    fi

    # 显示将删除的内容
    for f in "${files[@]}"; do
        size=$(du -sh "$f" 2>/dev/null | cut -f1)
        echo "  删除文件: $f ($size)"
    done
    if [ "$has_moddir" = true ]; then
        size=$(du -sh "$moddir" 2>/dev/null | cut -f1)
        echo "  删除目录: $moddir/ ($size)"
    fi
    if [ -n "$dpkg_pkg" ]; then
        echo "  卸载包:   $dpkg_pkg"
    fi

    echo ""
    read -p "确认删除以上所有内容? [y/N] " confirm
    if [ "${confirm,,}" != "y" ]; then
        echo "取消。"
        exit 0
    fi

    # 如果有 dpkg 包，优先用 apt 删除（会自动清理 /boot 和 /lib/modules）
    if [ -n "$dpkg_pkg" ]; then
        echo "通过 apt 卸载 $dpkg_pkg ..."
        apt-get purge -y "$dpkg_pkg"
    fi

    # 删除残余文件（apt 可能没清理手动安装的）
    for f in "${files[@]}"; do
        [ -f "$f" ] && rm -v "$f"
    done
    if [ "$has_moddir" = true ] && [ -d "$moddir" ]; then
        rm -rf "$moddir"
        echo "已删除 $moddir/"
    fi

    # 更新 grub
    echo ""
    echo "更新 GRUB..."
    update-grub 2>&1 | grep -v '^$'

    echo ""
    echo "=== 内核 $RKVER 已彻底删除 ==="
    exit 0
fi

# ── --status ──
if [ "${1:-}" = "--status" ]; then
    echo "=== 内核签名状态 ==="
    echo ""
    echo "当前内核: $(uname -r)"
    echo ""

    echo "--- 已安装的内核 ---"
    for vmlinuz in /boot/vmlinuz-*; do
        [ -f "$vmlinuz" ] || continue
        kver=$(basename "$vmlinuz" | sed 's/^vmlinuz-//')
        signed="否"
        if sbverify --cert "$SIGN_CERT" "$vmlinuz" >/dev/null 2>&1; then
            signed="是 ✓"
        fi
        echo "  $kver  签名: $signed"
    done

    echo ""
    echo "--- MOK 证书 ---"
    if mokutil --list-enrolled 2>/dev/null | grep -q 'Subject'; then
        mokutil --list-enrolled 2>/dev/null | grep -A1 'Subject'
    else
        echo "  未导入任何 MOK 证书"
    fi

    echo ""
    echo "--- Secure Boot ---"
    if mokutil --sb-state 2>/dev/null; then
        :
    else
        echo "  无法检测 Secure Boot 状态"
    fi
    exit 0
fi

# ── --import-mok ──
if [ "${1:-}" = "--import-mok" ]; then
    check_tools
    check_certs

    echo "=== 导入 MOK 证书到 UEFI ==="
    echo ""

    # 检查是否已导入
    if mokutil --list-enrolled 2>/dev/null | grep -q 'Surface GO'; then
        echo "证书已导入，无需重复操作。"
        mokutil --list-enrolled 2>/dev/null | grep -A1 'Subject'
        exit 0
    fi

    echo "证书: $SIGN_DER"
    echo ""
    echo "接下来会要求你设置一个【一次性密码】。"
    echo "请记住这个密码 — 重启后在蓝色 MOK Manager 界面需要输入。"
    echo ""

    mokutil --import "$SIGN_DER"

    echo ""
    echo "========================================="
    echo "  证书已排队等待注册。"
    echo ""
    echo "  请立即重启，在蓝色 MOK Manager 界面:"
    echo "    1. 选择 Enroll MOK"
    echo "    2. 选择 Continue → Yes"
    echo "    3. 输入刚才设置的密码"
    echo "    4. 选择 Reboot"
    echo ""
    echo "  重启后验证:"
    echo "    sudo mokutil --list-enrolled"
    echo "========================================="
    exit 0
fi

# ── 签名内核 ──
check_tools
check_certs

# 确定内核版本
KVER="${1:-$(uname -r)}"
VMLINUZ="/boot/vmlinuz-${KVER}"

echo "=== 签名内核: ${KVER} ==="

# 检查内核文件
if [ ! -f "$VMLINUZ" ]; then
    echo "错误: 找不到 $VMLINUZ" >&2
    echo ""
    echo "可用的内核:"
    ls /boot/vmlinuz-* 2>/dev/null | sed 's|/boot/vmlinuz-|  |'
    exit 1
fi

# 检查模块目录
if [ ! -d "/lib/modules/${KVER}" ]; then
    echo "警告: /lib/modules/${KVER} 不存在"
    echo "  initramfs 将无法包含内核模块。"
    echo "  如果是新编译的内核，请先运行: make modules_install"
    echo ""
    read -p "是否继续签名? [y/N] " confirm
    [ "${confirm,,}" = "y" ] || exit 1
fi

# 检查是否已签名
if sbverify --cert "$SIGN_CERT" "$VMLINUZ" >/dev/null 2>&1; then
    echo "该内核已签名，跳过。"
    exit 0
fi

# 备份
echo "  备份: ${VMLINUZ}.unsigned"
cp "$VMLINUZ" "${VMLINUZ}.unsigned"

# 签名
echo "  签名中..."
sbsign --key "$SIGN_KEY" \
       --cert "$SIGN_CERT" \
       --output "$VMLINUZ" \
       "${VMLINUZ}.unsigned"

# 验证
if sbverify --cert "$SIGN_CERT" "$VMLINUZ" >/dev/null 2>&1; then
    echo "  验证: 签名有效 ✓"
else
    echo "  验证: 签名无效 ✗ — 请检查证书" >&2
    # 还原备份
    cp "${VMLINUZ}.unsigned" "$VMLINUZ"
    exit 1
fi

# 更新 initramfs 和 grub
echo "  更新 initramfs..."
update-initramfs -u -k "$KVER" 2>&1 | grep -v '^$'

echo "  更新 GRUB..."
update-grub 2>&1 | grep -v '^$'

echo ""
echo "=== 完成 ==="
echo "内核 ${KVER} 已签名。"

# 检查 MOK 是否已导入
if ! mokutil --list-enrolled 2>/dev/null | grep -q 'Subject'; then
    echo ""
    echo "⚠  注意: UEFI 中尚未导入 MOK 证书！"
    echo "   请运行: sudo $0 --import-mok"
    echo "   然后重启在 MOK Manager 中注册证书。"
fi
