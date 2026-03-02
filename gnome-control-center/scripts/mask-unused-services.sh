#!/usr/bin/env bash
set -euo pipefail

# ────────────────────────────────────────────────────────────────
# mask-unused-services.sh — Mask gsd/tracker services not needed on Surface GO
#
# Masked services:
#   • gsd-wacom              — no Wacom digitiser on Surface GO
#   • gsd-smartcard          — no built-in smartcard reader (unrelated to SD card)
#   • gsd-print-notifications— no printer connected
#   • tracker-miner-fs-3     — file content indexer, heavy on SSD I/O
#   • evolution-data-server  — calendar/contacts backend (unused)
#
# NOTE: gsd-smartcard handles PKCS#11/PIV authentication smart cards,
#       NOT the microSD card slot. Your SD card reader is managed by
#       the kernel mmc/sd driver and udisks2 — completely unaffected.
#
# Usage:
#   sudo ./mask-unused-services.sh           # mask
#   sudo ./mask-unused-services.sh --unmask  # revert
# ────────────────────────────────────────────────────────────────

UNITS=(
  # gsd services (systemd user)
  org.gnome.SettingsDaemon.Wacom.service
  org.gnome.SettingsDaemon.Wacom.target
  org.gnome.SettingsDaemon.Smartcard.service
  org.gnome.SettingsDaemon.Smartcard.target
  org.gnome.SettingsDaemon.PrintNotifications.service
  org.gnome.SettingsDaemon.PrintNotifications.target
  # tracker / localsearch file miner (heavy I/O)
  # Debian 13 (GNOME 48) renamed tracker-miner-fs-3 → localsearch-3
  tracker-miner-fs-3.service
  localsearch-3.service
  # evolution-data-server (calendar/contacts)
  evolution-addressbook-factory.service
  evolution-calendar-factory.service
  evolution-source-registry.service
)

# ── 权限检查 ──
if [ "$(id -u)" -ne 0 ]; then
  echo "错误: 请使用 sudo 运行此脚本" >&2
  exit 1
fi

DEST="/etc/systemd/user"
mkdir -p "$DEST"

if [ "${1:-}" = "--unmask" ]; then
  echo "Unmasking services..."
  for u in "${UNITS[@]}"; do
    rm -fv "$DEST/$u"
  done
  echo "Done. Services will start on next login (re-login required)."
else
  echo "Masking unused gsd services..."
  for u in "${UNITS[@]}"; do
    # Validate unit name format (only allow alphanumeric, dash, dot, @)
    if ! echo "$u" | grep -qE '^[a-zA-Z0-9@._-]+\.service$|^[a-zA-Z0-9@._-]+\.target$'; then
      echo "  [skip] $u (invalid unit name format)"
      continue
    fi
    ln -sfv /dev/null "$DEST/$u"
  done
  echo "Done. Masked services will not start on next login."
  echo "Use '$0 --unmask' to revert."
fi
