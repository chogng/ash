# Ash GitHub authorization service

This Cloudflare Worker is the public callback and token exchange service for Ash Desktop's GitHub App. `ash-rs/github` owns the local loopback listener, PKCE verifier, token lifecycle, and profile secret storage. The Worker keeps the GitHub App Client Secret outside the desktop build and redirects the GitHub authorization code to the local listener using a signed, ten-minute state value.

## GitHub App

Register a GitHub App with callback URL `https://ash-github-auth.lanxiang0901.workers.dev/v1/oauth/github/callback`. Keep expiring user authorization tokens enabled and device flow and webhooks disabled. Account identity does not require repository or organization permissions. Add permissions only when a feature actually uses them. The public Client ID belongs in `resources/product-services/product-services.json`; never commit the Client Secret. Generate a **Client secret** under the GitHub App's **Client secrets** section. A **Private key** is a different credential and cannot be used for this token exchange.

## Cloudflare Worker

The Worker is named `ash-github-auth` and runs at `https://ash-github-auth.lanxiang0901.workers.dev/`. Deploy from this directory with `wrangler deploy`. Configure three Worker secrets with `wrangler secret put`: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `STATE_SIGNING_SECRET`. The Client ID is public, but storing all three in Worker settings keeps deployment configuration together. Generate `STATE_SIGNING_SECRET` from at least 32 random bytes. Do not place tokens or secrets in Wrangler variables, logs, source control, or chat.

Run `node --test worker.test.mjs` before deployment. After deployment, a request to `/v1/oauth/github/authorize` without parameters must return `400 Invalid authorization request`; a `503` means a Worker secret is missing. The complete login flow should be verified in the desktop app by clicking **Connect GitHub**, authorizing Ash once in the browser, and checking that Ash shows the connected account without requesting a device code.
