#!/usr/bin/env bash
set -euo pipefail

OUTDIR="${1:-$PWD/gnome-shell-rollback-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUTDIR"

PACKAGES=(
  gnome-shell
  gnome-shell-common
  gnome-shell-extension-prefs
)

VERSIONS_FILE="$OUTDIR/installed-versions.tsv"
: > "$VERSIONS_FILE"

echo "[1/4] 记录当前包版本..."
for pkg in "${PACKAGES[@]}"; do
  if dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed"; then
    ver="$(dpkg-query -W -f='${Version}' "$pkg")"
    printf "%s\t%s\n" "$pkg" "$ver" >> "$VERSIONS_FILE"
    echo "  - $pkg=$ver"
  fi
done

echo "[2/4] 下载当前已安装版本的 deb（用于离线回滚）..."
(
  cd "$OUTDIR"
  while IFS=$'\t' read -r pkg ver; do
    apt-get download "${pkg}=${ver}" || true
  done < "$VERSIONS_FILE"
)

echo "[3/4] 生成回滚脚本..."
cat > "$OUTDIR/restore.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if compgen -G "*.deb" > /dev/null; then
  sudo apt-get install -y --allow-downgrades ./*.deb
else
  mapfile -t TARGETS < <(awk -F '\t' '{print $1"="$2}' installed-versions.tsv)
  if [ "${#TARGETS[@]}" -eq 0 ]; then
    echo "没有可回滚记录。"
    exit 1
  fi
  sudo apt-get install -y --allow-downgrades "${TARGETS[@]}"
fi

echo "回滚安装完成。建议执行: sudo systemctl restart gdm"
EOF
chmod +x "$OUTDIR/restore.sh"

echo "[4/4] 写入元信息..."
{
  echo "created_at=$(date -Is)"
  echo "host=$(hostname)"
  echo "kernel=$(uname -r)"
  echo "shell_version=$(gnome-shell --version 2>/dev/null || true)"
} > "$OUTDIR/meta.txt"

echo "已完成。回滚包目录: $OUTDIR"
echo "回滚命令: $OUTDIR/restore.sh"
