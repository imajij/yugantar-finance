#!/usr/bin/env bash
# One-off: move the data from Neon to the RDS database behind the EC2 host.
#
#   infra/migrate-neon-to-rds.sh
#
# Works the way infra/deploy-ec2.sh does, and for the same reason (the operator role
# may open a Session Manager shell and nothing more): it builds one command, puts it
# on your clipboard and opens a shell on the host. Paste it there. The host can reach
# both databases; your laptop cannot reach RDS.
#
# On the host it:
#   1. dumps Neon (public and drizzle schemas; read-only, Neon is left untouched)
#   2. stops the app
#   3. replaces everything in RDS with the dump
#   4. checks every table's row count against Neon, table by table
#   5. applies any migrations newer than Neon's, and starts the app again
#
# RDS is *replaced*, not merged. Before this runs it holds only what the first deploy
# seeded; the script snapshots it first all the same.
#
# Anything written to Neon after the dump is not carried over. Stop the Vercel
# deployment (or put it in maintenance) before running this.
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-yugaantar-operator}"
export AWS_REGION="${AWS_REGION:-ap-south-1}"

INSTANCE_ID=i-035bcc83bb735658c
DB_INSTANCE=yugaantar-finance-db
DB_HOST=yugaantar-finance-db.cp44wk22oekm.ap-south-1.rds.amazonaws.com
DB_USER=yugaantar_admin
DB_NAME=yugantar

cd "$(dirname "$0")/.."

command -v session-manager-plugin >/dev/null || {
  echo "Install the Session Manager plugin first: brew install --cask session-manager-plugin" >&2; exit 1; }

DB_PASSWORD=$(cat "$HOME/.config/yugaantar/db-password")
RDS_URL="postgres://$DB_USER:$DB_PASSWORD@$DB_HOST:5432/$DB_NAME?sslmode=require"

# Neon's URL from .env. pg_dump needs a direct connection, not the pooler: PgBouncer
# in transaction mode cannot hold the snapshot a consistent dump relies on.
NEON_URL="${NEON_URL:-$(node -e '
  const m = /^DATABASE_URL\s*=\s*(.*)$/m.exec(require("node:fs").readFileSync(".env", "utf8"));
  if (m) console.log(m[1].trim().replace(/^(["\x27])(.*)\1$/, "$2"));
')}"
NEON_URL=$(node -e '
  const u = new URL(process.argv[1]);
  u.hostname = u.hostname.replace("-pooler.", ".");
  console.log(u.toString());
' "$NEON_URL")
case "$NEON_URL" in
  *neon.tech*) ;;
  *) echo "DATABASE_URL in .env is not a Neon URL. Set NEON_URL=... and rerun." >&2; exit 1 ;;
esac
echo "Source: $(node -e 'console.log(new URL(process.argv[1]).host)' "$NEON_URL")"
echo "Target: $DB_HOST"

cat <<EOF

This REPLACES everything in RDS ($DB_INSTANCE) with the contents of Neon.
Neon itself is only read. Writes to Neon after the dump will not be copied,
so stop the Vercel deployment first.

EOF
read -r -p "Type 'migrate' to continue: " answer
[ "$answer" = migrate ] || { echo "Stopped."; exit 1; }

SNAPSHOT="yugaantar-finance-db-pre-neon-import-$(date +%Y%m%d%H%M)"
if aws rds create-db-snapshot --db-instance-identifier "$DB_INSTANCE" --db-snapshot-identifier "$SNAPSHOT" \
     --tags Key=Project,Value=YugaantarFinance --query DBSnapshot.DBSnapshotIdentifier --output text; then
  echo "Snapshot $SNAPSHOT started. It finishes in the background."
else
  read -r -p "Could not snapshot RDS (error above). Continue without one? [y/N] " yn
  [ "$yn" = y ] || exit 1
fi

REMOTE=$(cat <<EOF
set -euo pipefail
SRC='$NEON_URL'
DST='$RDS_URL'

command -v pg_dump >/dev/null || dnf install -y -q postgresql17
echo "==> neon: \$(psql "\$SRC" -Atc 'show server_version')   rds: \$(psql "\$DST" -Atc 'show server_version')"

# Every table in public, with its exact row count, one per line.
counts() {
  psql "\$1" -At -v ON_ERROR_STOP=1 <<'SQL'
select t.table_name || ' ' || (xpath('/row/c/text()',
         query_to_xml(format('select count(*) as c from public.%I', t.table_name), false, true, '')))[1]::text
from information_schema.tables t
where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
order by 1;
SQL
}

DUMP=/root/neon-\$(date +%Y%m%d%H%M%S).dump
echo "==> dumping neon to \$DUMP"
pg_dump "\$SRC" -Fc --no-owner --no-acl -n public -n drizzle -f "\$DUMP"
counts "\$SRC" > /root/neon-counts.txt
echo "    \$(wc -l < /root/neon-counts.txt) tables"

echo "==> stopping the app"
systemctl stop yugaantar-cron-frequent.timer yugaantar-cron-daily.timer 2>/dev/null || true
systemctl stop yugaantar

echo "==> clearing rds"
psql "\$DST" -v ON_ERROR_STOP=1 -q <<'SQL'
drop schema if exists drizzle cascade;
drop schema public cascade;
create schema public;
create extension if not exists citext;
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
SQL

echo "==> restoring"
# The dump's own CREATE SCHEMA public would collide with the one just made (it has
# to exist first, for the extensions the tables' types come from).
pg_restore -l "\$DUMP" | grep -v ' SCHEMA - public ' > /root/restore.toc
pg_restore --no-owner --no-acl --exit-on-error -L /root/restore.toc -d "\$DST" "\$DUMP"

echo "==> comparing row counts"
counts "\$DST" > /root/rds-counts.txt
if diff /root/neon-counts.txt /root/rds-counts.txt; then
  echo "    all \$(wc -l < /root/rds-counts.txt) tables match"
else
  echo "ROW COUNTS DIFFER (above: < neon, > rds). The app is left stopped." >&2
  exit 1
fi

echo "==> migrations newer than neon's"
sudo -u yugaantar -H bash -c 'export PATH=/usr/local/bin:\$PATH; cd /opt/yugaantar/app && pnpm exec tsx --env-file=.env.production.local db/migrate.mts'

echo "==> starting the app"
systemctl start yugaantar
systemctl start yugaantar-cron-frequent.timer yugaantar-cron-daily.timer 2>/dev/null || true
for i in \$(seq 1 30); do curl -fs -o /dev/null http://127.0.0.1:3000/sign-in && break; sleep 2; done
echo "==> sign-in page: \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/sign-in)"
echo "MIGRATED  (dump kept at \$DUMP)"
EOF
)

printf '(umask 077; echo %s | base64 -d > /tmp/yg-migrate.sh) && sudo bash /tmp/yg-migrate.sh; rm -f /tmp/yg-migrate.sh\n' \
  "$(printf '%s' "$REMOTE" | base64)" | pbcopy

cat <<EOF

The migration command is in your clipboard. A shell on $INSTANCE_ID opens next:
  1. paste (Cmd+V) and press Enter
  2. wait for "MIGRATED"
  3. type exit

EOF
read -r -p "Press Enter to open the session… " _
aws ssm start-session --target "$INSTANCE_ID"

printf '' | pbcopy
echo "Clipboard cleared."
