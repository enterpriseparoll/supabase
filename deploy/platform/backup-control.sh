#!/bin/sh
set -eu
umask 077
cd "$(dirname "$0")"
# Run as a host administrator. This includes encrypted project credentials and
# must be retained with an offline copy of the master and restic keys.
root=${PLATFORM_DATA_ROOT:-/srv/supabase-platform}
case "$root" in /*) ;; *) echo 'Use an absolute PLATFORM_DATA_ROOT' >&2; exit 1 ;; esac
staging="$root/control-backup"
mkdir -p "$staging"
docker compose -f compose.yml stop api worker
trap 'docker compose -f compose.yml up -d api worker' EXIT
docker compose -f compose.yml exec -T control-db pg_dump -U control_owner -d control -Fc > "$staging/control.dump"
cp .env "$staging/deployment.env"
mkdir -p "$staging/secrets"
cp -R "$root/secrets/." "$staging/secrets/"
docker compose -f compose.yml run --rm worker node src/backup-tool.mjs backup "$staging" --tag control-plane
echo 'Control database and protected deployment files backed up. Keep the offline recovery key copy separate.'
