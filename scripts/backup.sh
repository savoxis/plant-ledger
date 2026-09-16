#!/bin/sh
# Snapshot the plant-ledger data volume (SQLite DB + photos) to a dated
# tarball and prune anything older than RETENTION_DAYS.
#
# Run this on the HOST (not inside the container) via cron or Unraid's
# User Scripts plugin, e.g. daily at 3am:
#   0 3 * * * /path/to/backup.sh
#
# Usage: backup.sh [data_dir] [backup_dir] [retention_days]

set -eu

DATA_DIR="${1:-/mnt/user/appdata/plant-ledger}"
BACKUP_DIR="${2:-/mnt/user/backups/plant-ledger}"
RETENTION_DAYS="${3:-30}"
STAMP=$(date +%Y%m%d-%H%M%S)

if [ ! -d "$DATA_DIR" ]; then
  echo "Data dir not found: $DATA_DIR" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# SQLite's own backup API avoids grabbing a half-written file mid-write;
# fall back to a plain copy if sqlite3 isn't on the host.
if command -v sqlite3 >/dev/null 2>&1 && [ -f "$DATA_DIR/plants.db" ]; then
  sqlite3 "$DATA_DIR/plants.db" ".backup '$STAGE/plants.db'"
else
  cp "$DATA_DIR/plants.db" "$STAGE/plants.db"
fi
cp -a "$DATA_DIR/photos" "$STAGE/photos" 2>/dev/null || mkdir -p "$STAGE/photos"

tar -czf "$BACKUP_DIR/plant-ledger-$STAMP.tar.gz" -C "$STAGE" .

find "$BACKUP_DIR" -name 'plant-ledger-*.tar.gz' -mtime "+$RETENTION_DAYS" -delete

echo "Backed up $DATA_DIR -> $BACKUP_DIR/plant-ledger-$STAMP.tar.gz"
