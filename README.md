# DevPulse Infra Radar

**A private, read-only Telegram command center for GitHub + Cloudflare.** Built for Cloudflare Workers with a D1 binding; no KV dependency and no third-party runtime packages.

## What it can show

- GitHub profile metrics and owned repositories (visibility, stars, forks, language, branches, size, dates, license, archive state).
- Per-repository metadata, recent traffic views/clones when the API token is authorized, the last five Actions runs, and Pages configuration/build information.
- GitHub Pages repositories, source branch, custom domain, build type/status, and direct site/settings/deployment links.
- Public recent GitHub activity.
- Cloudflare Worker scripts, safe binding names/types (not values), Workers invocation analytics through the read-only GraphQL Analytics API, and direct links to Observability/Logs.
- Cloudflare Pages projects and metadata.
- Inventory for D1, R2, KV, Durable Objects namespaces, Queues, Hyperdrive, and Vectorize where the Account API token permits access.
- Dashboard links for usage, billing, logs, actions, resource settings, and traffic graphs.

## Safety boundaries

- Every Telegram update is restricted to the single `TELEGRAM_OWNER_ID`, in a private chat.
- The webhook validates both a hard-to-guess URL path and Telegram's `X-Telegram-Bot-Api-Secret-Token` header.
- GitHub and Cloudflare API requests are read-only (`GET`) except Cloudflare GraphQL `POST` used solely for analytics queries. There are no repository mutations, deployments, resource edits, deletes, queries against your other Cloudflare D1 databases, object downloads, KV value reads, or secret reads. The bot writes only its own temporary UI references and a small bounded audit record to the D1 database bound to this Worker.
- Cloudflare Observability log rows are linked to the dashboard rather than queried via the API because the current query endpoint documents a `Workers Observability Write` permission. Do not grant that permission just to keep this bot read-only.
- D1 is used only for temporary callback references and a bounded audit of command names/user ID/timestamps. Message bodies, API responses, credentials, and secret values are not stored.
- This is an administrative personal bot. Never commit access tokens or webhook secrets to GitHub.

## Quick setup

Follow `SETUP_FA.md` for the complete Persian walkthrough. High-level commands:

```powershell
npm install -g wrangler
npx wrangler login
npx wrangler d1 create devpulse-infra-bot-db
# Paste the database_id returned into wrangler.toml.
npx wrangler d1 migrations apply devpulse-infra-bot-db --remote
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_OWNER_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler deploy
```

Then register the webhook using the command in `SETUP_FA.md`. Set the worker URL based on Wrangler's deployment output. Run the offline checks with `npm test` and `npm run check`.

## Required Worker secrets

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_OWNER_ID` — numeric Telegram user ID, not username
- `TELEGRAM_WEBHOOK_SECRET` — random string `[A-Za-z0-9_-]`, 32+ characters recommended
- `GITHUB_TOKEN` — fine-grained PAT with read-only permissions
- `CLOUDFLARE_API_TOKEN` — custom API token with only the read permissions needed for the desired inventory

Non-secret vars `GITHUB_USERNAME` and `CLOUDFLARE_ACCOUNT_ID` are in `wrangler.toml`.

## API limitations

- GitHub traffic endpoints generally expose only the last 14 days and require adequate repository access/token permissions.
- GitHub Pages API does not provide a built-in Pages page-view count; repository traffic is not the same metric as website traffic.
- Account resource endpoints expose metadata and usage only where Cloudflare provides it and the account/token/plan permit access.
- Secrets are intentionally never retrievable. KV values and R2 object contents are not accessed.
- Workers logs can be viewed in Cloudflare dashboard using the bot's direct links. The programmatic Observability query endpoint is omitted to avoid the permission labelled `Workers Observability Write`.

## Troubleshooting

- `GET /health` shows whether the required configuration is present (it never returns secret contents).
- A `403` or permission message means add the corresponding **Read** permission to the token; do not add Write access as a workaround.
- A missing D1 table means run `npx wrangler d1 migrations apply devpulse-infra-bot-db --remote`.
- If Telegram webhook is not receiving updates, rerun `setWebhook` with the exact deployed URL and exact `TELEGRAM_WEBHOOK_SECRET`.
