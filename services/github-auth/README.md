# Ash GitHub authorization service

This Cloudflare Worker is the public callback and token exchange service for Ash Desktop's GitHub browser authorization. `crates/github` owns the local loopback listener, PKCE verifier, token lifecycle, and profile secret storage. The Worker keeps the OAuth client's secret outside the desktop build and redirects the GitHub authorization code to the local listener using a signed, ten-minute state value.

Desktop login already uses `account/login/start` with `gitHubBrowser`. The frontend opens the returned authorization URL; the Worker redirects to GitHub and returns the authorization code to Ash's local listener. The Rust backend exchanges that code through the Worker, reads the GitHub account identity, and stores the grant. Opening the authorization page alone does not complete login: the user must approve it in GitHub, and `account/read` must report the GitHub account as `ready`.

Credentials belong to the selected `ASH_HOME` (by default `~/.ash`) through `ash-secrets`. This OAuth user grant authorizes the built-in GitHub API operations. Git clone/fetch/pull/push continue using Git's own SSH or HTTPS credentials; they do not use this Worker or the GitHub CLI login store.

## Desktop OAuth App

Use the existing [Ash Desktop OAuth App](https://github.com/settings/applications/3884506), whose public Client ID is `Ov23linTZCPimNOTyngv`. Its redirect URI must be `https://ash-github-auth.lanxiang0901.workers.dev/v1/oauth/github/callback`; the repository homepage is not an authorization callback. The public Client ID belongs in `resources/product-services/product-services.json`. Configure this same Client ID and the OAuth App's matching Client Secret in the Worker, with the secret kept outside the desktop build and source control.

Browser authorization requests `read:user repo notifications`. The grant covers account identity, repository operations, the product issue reporter, and notification reads and changes, within the user's own repository access. OAuth `repo` access is broader than GitHub App repository selection. The report target remains the repository configured by `reportIssueUrl`. A permission refusal preserves the draft and reports a permission error; changing Worker settings does not grant the user access to a repository.

Changing the configured application identity requires users to sign in again. An existing GitHub App grant does not become an OAuth App grant and cannot read notifications. The backend checks the credential's Client ID against the current host configuration before using it. OAuth tokens without expiry or refresh fields are supported; expiring tokens use the existing refresh lifecycle.

### GitHub App distributions

A distribution can configure a GitHub App for repository operations. Keep expiring user authorization tokens enabled and device flow and webhooks disabled. Configure **Issues: Read and write** for issues and comments, **Pull requests: Read and write** for PR creation and reviews, **Contents: Read and write** for merging, and **Checks: Read** plus **Commit statuses: Read** for checks. Repository access also depends on the App installation and the user's own permissions. These grants cannot call the notification endpoints. A Client Secret and an App private key are different credentials; the private key cannot be used for this token exchange.

## Cloudflare Worker

The Worker is named `ash-github-auth` and runs at `https://ash-github-auth.lanxiang0901.workers.dev/`. Deploy from this directory with `wrangler deploy`. Configure three Worker secrets with `wrangler secret put`: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `STATE_SIGNING_SECRET`. The Client ID is public, but storing all three in Worker settings keeps deployment configuration together. Generate `STATE_SIGNING_SECRET` from at least 32 random bytes. Do not place tokens or secrets in Wrangler variables, logs, source control, or chat.

Run `node --test worker.test.mjs` before deployment. After deployment, a request to `/v1/oauth/github/authorize` without parameters must return `400 Invalid authorization request`; a `503` means a Worker secret is missing. For an HTTP health probe, use the desktop client's real User-Agent: `curl -i --user-agent "Ash Desktop" https://ash-github-auth.lanxiang0901.workers.dev/v1/oauth/github/authorize`. Cloudflare's browser checks can reject other automation clients before they reach the Worker. Verify the browser redirect separately, including the configured Client ID, Worker callback and PKCE challenge. The complete login flow should be verified in the desktop app by clicking **Connect GitHub**, authorizing Ash once in the browser, and checking that Ash shows the connected account without requesting a device code.

## Enterprise browser authorization

Deploy this broker separately for each Enterprise Server instance with `GITHUB_HOST=git.example.com`, the instance's `GITHUB_CLIENT_ID`, and its secret `GITHUB_CLIENT_SECRET`. Register its OAuth App callback as `https://git-auth.example.com/v1/oauth/github/callback`. The deployment must reach the instance over HTTPS; a private instance requires a broker deployed on its reachable network. The broker host is fixed by deployment configuration, never by request parameters. Signed callback state also binds the host. OAuth App authorization requests `read:user repo notifications`; GitHub App permissions are configured in the App itself.

Add the public settings to the product-services document:

```json
{
  "schemaVersion": 2,
  "githubEnterpriseAccounts": [
    {
      "host": "git.example.com",
      "clientId": "ENTERPRISE_PUBLIC_CLIENT_ID",
      "brokerBaseUrl": "https://git-auth.example.com/"
    }
  ]
}
```

In the GitHub editor's repository menu, choose **Sign in to GitHub Enterprise**, enter `git.example.com`, and authorize in the browser. Account credentials and refresh remain scoped to that host. Existing GitHub.com configuration can coexist with these entries. Client secrets never belong in the product-services file or renderer. Broker and OAuth App deployment are administrator prerequisites; tests use controlled HTTP responses and do not verify a live Enterprise installation.

Notifications require OAuth App authorization or a classic PAT with `notifications` or `repo` scope. GitHub's notification endpoints reject GitHub App and fine-grained tokens. The desktop product configuration uses the OAuth App above for GitHub.com browser login; its Client ID and matching secret must also be configured in the deployed broker. Fork creation requires the destination account's repository creation permission; with a GitHub App, grant **Administration: Write** and **Contents: Read**, install it on the source repository, and install it on the destination account with access to all repositories as described in the [GitHub fork API](https://docs.github.com/en/rest/repos/forks#create-a-fork).
