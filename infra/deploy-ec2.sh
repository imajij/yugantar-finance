#!/usr/bin/env bash
# Deploy a commit to the Yugaantar Finance EC2 host, through Session Manager.
#
#   infra/deploy-ec2.sh            # deploys the commit checked out here (must be pushed)
#   infra/deploy-ec2.sh <sha|ref>  # deploys that commit instead
#   SEED=1 infra/deploy-ec2.sh     # also runs db/seed.mts (a fresh, empty database only;
#                                  # after the Neon import the fest already exists)
#
# The operator role may open a Session Manager shell but may not run SSM commands
# or write to S3, so the code cannot be pushed to the host. Instead this builds one
# command, copies it to your clipboard and opens a shell on the host: paste it
# there (Cmd+V, Enter). The host then downloads the commit from GitHub through a
# short-lived link, writes its .env, migrates, seeds, builds and restarts.
#
# The pasted command carries the production secrets, base64-encoded. Paste it only
# into the session this script opens, and don't leave it in the clipboard after.
#
# Needs: aws (profile yugaantar-operator), gh (logged in), session-manager-plugin.
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-yugaantar-operator}"
export AWS_REGION="${AWS_REGION:-ap-south-1}"

INSTANCE_ID=i-035bcc83bb735658c
APP_URL=https://16-4-14-159.sslip.io
DB_HOST=yugaantar-finance-db.cp44wk22oekm.ap-south-1.rds.amazonaws.com
DB_USER=yugaantar_admin
DB_NAME=yugantar
REPO=imajij/yugantar-finance

cd "$(dirname "$0")/.."

# ------------------------------------------------------------ local secrets
# Kept outside the repo, generated once, reused on every deploy so sessions,
# signed upload URLs and the cron token survive a redeploy.
SECRETS_DIR="$HOME/.config/yugaantar"
mkdir -p "$SECRETS_DIR" && chmod 700 "$SECRETS_DIR"
if [ ! -s "$SECRETS_DIR/db-password" ]; then
  src=/private/tmp/claude-501/-Users-ajijuttam-projects-yugantar-finance/fce1f6ca-3907-48ae-b6f1-3f7df22f4c1e/scratchpad/db-password
  [ -s "$src" ] || { echo "No RDS password at $SECRETS_DIR/db-password (or $src)." >&2; exit 1; }
  install -m 600 "$src" "$SECRETS_DIR/db-password"
  echo "Saved the RDS master password to $SECRETS_DIR/db-password"
fi
for name in cron-secret upload-url-secret; do
  [ -s "$SECRETS_DIR/$name" ] || (umask 077; openssl rand -hex 32 > "$SECRETS_DIR/$name")
done

# ----------------------------------------------------------- prerequisites
command -v session-manager-plugin >/dev/null || {
  echo "Install the Session Manager plugin first: brew install --cask session-manager-plugin" >&2; exit 1; }
aws sts get-caller-identity --query Arn --output text >/dev/null
gh auth status >/dev/null 2>&1 || { echo "gh is not logged in: gh auth login" >&2; exit 1; }

# ------------------------------------------------------------------ commit
SEED="${SEED:-0}"
REF="${1:-HEAD}"
SHA=$(git rev-parse "$REF^{commit}")
git fetch -q origin
git branch -r --contains "$SHA" | grep -q . || { echo "$SHA is not pushed to origin." >&2; exit 1; }
echo "Deploying $(git log -1 --format='%h %s' "$SHA")"

# ---------------------------------------------------------------- the .env
# Service keys come from your local .env, which holds the real ones; .env.local (the
# dev overrides, where Resend and the R2 keys are blanked) only fills gaps such
# as the bootstrap admin. Blank never counts. The database, URL and the two secrets
# are production's own.
DB_PASSWORD=$(cat "$SECRETS_DIR/db-password")
ENV_FILE=$(
  DATABASE_URL="postgres://$DB_USER:$DB_PASSWORD@$DB_HOST:5432/$DB_NAME?sslmode=require" \
  APP_URL="$APP_URL" \
  CRON_SECRET="$(cat "$SECRETS_DIR/cron-secret")" \
  UPLOAD_URL_SECRET="$(cat "$SECRETS_DIR/upload-url-secret")" \
  node -e '
    const fs = require("node:fs");
    const parse = (f) => {
      const out = {};
      if (!fs.existsSync(f)) return out;
      for (const line of fs.readFileSync(f, "utf8").split("\n")) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        const v = m && m[2].trim().replace(/^(["\x27])(.*)\1$/, "$2").trim();
        if (v) out[m[1]] = v;
      }
      return out;
    };
    const local = { ...parse(".env.local"), ...parse(".env") };
    const copied = [
      "ALLOWED_EMAIL_DOMAIN", "EMAIL_FROM", "RESEND_API_KEY",
      "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT",
      "BOOTSTRAP_ADMIN_EMAIL", "BOOTSTRAP_ADMIN_NAME", "BOOTSTRAP_FEST_NAME", "BOOTSTRAP_FEST_SLUG",
    ];
    const own = ["DATABASE_URL", "APP_URL", "CRON_SECRET", "UPLOAD_URL_SECRET"];
    const lines = [];
    for (const k of copied) if (local[k]) lines.push([k, local[k]]);
    for (const k of own) lines.push([k, process.env[k]]);
    for (const [k, v] of lines) {
      if (/["\\\n]/.test(v)) { console.error(`${k} contains a quote or backslash; set it by hand.`); process.exit(1); }
      console.log(`${k}="${v}"`);
    }
  '
)

# ------------------------------------------------------- short-lived code link
# GitHub answers a tarball request with a redirect to a codeload URL carrying a
# token that expires in a few minutes, so the host needs no GitHub credentials.
TARBALL_URL=$(curl -fsS -o /dev/null -w '%{redirect_url}' \
  -H "Authorization: Bearer $(gh auth token)" \
  "https://api.github.com/repos/$REPO/tarball/$SHA")
[ -n "$TARBALL_URL" ] || { echo "GitHub did not return a tarball link." >&2; exit 1; }

# ------------------------------------------------------------ scheduled jobs
# The host runs its own: every five minutes for the ticket SLA clock and the email
# outbox (PRD 14 wants minutes), and everything once a day. They call the app on
# localhost with CRON_SECRET, so nothing leaves the box. Rewritten on every deploy.
CRON_SETUP=$(cat <<'CRON'
cat > /usr/local/bin/yugaantar-cron <<'EOF'
#!/bin/bash
# yugaantar-cron <job>... — POSTs each /api/v1/cron/<job> on the local app.
set -uo pipefail
secret=$(sed -n 's/^CRON_SECRET="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /opt/yugaantar/app/.env.production.local)
failed=0
for job in "$@"; do
  if ! body=$(curl -sS --fail-with-body --max-time 300 -X POST \
      -H "authorization: Bearer $secret" "http://127.0.0.1:3000/api/v1/cron/$job"); then
    echo "$job failed: $body" >&2; failed=1
  else
    echo "$job: $body"
  fi
done
exit $failed
EOF
chmod 755 /usr/local/bin/yugaantar-cron

unit() { # name, schedule, jobs
  cat > /etc/systemd/system/yugaantar-cron-$1.service <<EOF
[Unit]
Description=Yugaantar scheduled jobs ($1)
After=yugaantar.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/yugaantar-cron $3
EOF
  cat > /etc/systemd/system/yugaantar-cron-$1.timer <<EOF
[Unit]
Description=Yugaantar scheduled jobs ($1)

[Timer]
OnCalendar=$2
Persistent=true

[Install]
WantedBy=timers.target
EOF
}
unit frequent '*:0/5' 'ticket-sla outbox'
unit daily '*-*-* 02:30:00 UTC' 'all'
systemctl daemon-reload
systemctl enable --now yugaantar-cron-frequent.timer yugaantar-cron-daily.timer
CRON
)

# ------------------------------------------------------ what runs on the host
REMOTE=$(cat <<EOF
set -euo pipefail
cd /opt/yugaantar
echo "==> downloading $SHA"
curl -fsSL '$TARBALL_URL' -o /tmp/app.tgz
rm -rf app.new && mkdir app.new
tar -xzf /tmp/app.tgz -C app.new --strip-components=1 && rm -f /tmp/app.tgz
echo '$(printf '%s\n' "$ENV_FILE" | base64)' | base64 -d > app.new/.env.production.local
[ -d app/.uploads ] && mv app/.uploads app.new/.uploads || true
chown -R yugaantar:yugaantar app.new && chmod 600 app.new/.env.production.local

sudo -u yugaantar -H bash -c '
  set -euo pipefail
  export PATH=/usr/local/bin:\$PATH
  cd /opt/yugaantar/app.new
  echo "==> install";  pnpm install --frozen-lockfile
  echo "==> migrate";  pnpm exec tsx --env-file=.env.production.local db/migrate.mts
  if [ "$SEED" = 1 ]; then echo "==> seed"; pnpm exec tsx --env-file=.env.production.local db/seed.mts; fi
  echo "==> build";    NODE_ENV=production pnpm build
'

echo "==> switching over"
rm -rf app.old
[ -d app ] && mv app app.old
mv app.new app
systemctl restart yugaantar
echo '$(printf '%s\n' "$CRON_SETUP" | base64)' | base64 -d | bash
for i in \$(seq 1 30); do
  curl -fs -o /dev/null http://127.0.0.1:3000/ && break; sleep 2
done
systemctl --no-pager --lines=5 status yugaantar | head -12 || true
systemctl list-timers 'yugaantar-cron-*' --no-pager | head -4
echo "==> public: \$(curl -s -o /dev/null -w '%{http_code}' $APP_URL/)"
echo "DEPLOYED $SHA"
EOF
)

# Written to a file first: piped straight into bash, pnpm would read the rest of
# the script from stdin as its own input.
printf '(umask 077; echo %s | base64 -d > /tmp/yg-deploy.sh) && sudo bash /tmp/yg-deploy.sh; rm -f /tmp/yg-deploy.sh\n' \
  "$(printf '%s' "$REMOTE" | base64)" | pbcopy

cat <<EOF

The deploy command is in your clipboard. It expires in about 5 minutes.
A shell on $INSTANCE_ID opens next:
  1. paste (Cmd+V) and press Enter
  2. wait for "DEPLOYED $SHA" (a few minutes: install + build)
  3. type exit
If it fails with a 404 on download, the link expired: run this script again.

EOF
read -r -p "Press Enter to open the session… " _
aws ssm start-session --target "$INSTANCE_ID"

# Don't leave production secrets on the clipboard.
printf '' | pbcopy
echo "Clipboard cleared. App: $APP_URL"
