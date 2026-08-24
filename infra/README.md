# R2 bucket configuration

The receipts bucket is configured from here rather than by clicking, so the settings
are reviewable and can be reapplied to a new account without anyone remembering what
was ticked.

## CORS — `r2-cors.json`

Receipts are PUT straight from the browser to a presigned URL (PRD 20.2), so the
upload is a cross-origin request with a non-safelisted `Content-Type` and is
preflighted. Without this policy the presign call succeeds and the PUT fails, which
surfaces as an opaque "Upload failed" in the receipt form.

`AllowedOrigins` must list **every** origin the app is served from, including preview
deployments. Add one and reapply:

```bash
# edit infra/r2-cors.json, then
npx wrangler r2 bucket cors set yugaantar-receipts --file infra/r2-cors.json
npx wrangler r2 bucket cors list yugaantar-receipts     # confirm
```

`GET` is allowed alongside `PUT` for the sake of anything that later fetches a file
rather than linking to it. Today's download path renders the signed URL into an
`<a>` or `<img>`, which CORS does not govern.

## What is deliberately not set

- **Public access (`r2.dev`) stays off.** Every file is served through a 15-minute
  signed URL issued only to someone who can see the parent record
  (`lib/services/attachments.ts`). A public bucket URL would bypass that entirely.
- **No lifecycle rule.** PRD 11 wants two years' retention for the college audit, and
  nothing in the app deletes a file belonging to a record — removal is soft. The only
  deletions come from the nightly `gc-attachments` job, and only for uploads that
  never got a parent. Add a lifecycle rule only if you decide to enforce the two-year
  ceiling automatically.

# Scheduled jobs

`vercel.json` carries one daily cron, because Vercel's Hobby plan allows no more
than that: a single call to `/api/v1/cron/all`, which runs every job in sequence.

The ticket SLA clock needs minutes rather than days (PRD 14), so
`.github/workflows/cron.yml` calls `ticket-sla` and `outbox` every five minutes from
GitHub Actions. Set on the repository, under Settings → Secrets and variables:

| | Name | Value |
|---|---|---|
| Secret | `CRON_SECRET` | the same value as the deployment's |
| Variable | `APP_URL` | `https://yugantar.ajij.dev` |

Without both it no-ops rather than failing.

GitHub's scheduler is best-effort — five minutes is the floor, ten is common, and
runs are dropped under load. Before fest week, point a real scheduler at the same
endpoints: Vercel Pro restores `vercel.json`'s original cadences verbatim, and a
Cloudflare Worker cron or any hosted scheduler works too. The endpoints do not care
who calls them, only that the bearer token is right.
