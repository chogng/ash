# ash-xai

- Own xAI subscription device authorization and cancellation.
- Store and refresh Ash-owned credentials through the secret store.
- Resolve authenticated Grok CLI proxy requests per invocation.
- Delegate model catalog, account, settings, and subscription usage HTTP requests and decoding to `backend-client::xai`; retain account checks and one-time authentication recovery.
- Read an existing Grok CLI OAuth access token without touching Grok's rotating refresh token or credential file. When Ash signs in, keep its credentials separate from API keys and Grok CLI storage.

## Subscription transport

- Device authorization uses `auth.x.ai/oauth2/device/code` and `auth.x.ai/oauth2/token`.
- Inference uses `https://cli-chat-proxy.grok.com/v1/responses` over HTTP/SSE; account models come from `/models-v2`.
- The account provider ID is `xai-subscription`; model references use the vendor ID `xai` for both subscription and API access. Ash stores subscription credentials in its profile secret store and coordinates refreshes through the profile's `xai.lock`. When both credentials are available, the ready subscription takes precedence.
- If Ash has no subscription credential, it reads `~/.grok/auth.json` on the backend host for a valid official Grok OAuth access token. It reads only the matching entry's access token, account identity, email, and expiry. Ash never copies the Grok refresh token or writes the file. An Ash-owned credential takes precedence once the user signs in to Ash. A malformed Grok file reports an error instead of silently choosing another account.
- Start from Ash Code's `/config` → Providers → xAI. Existing valid Grok login connects immediately. Otherwise Ash Code opens the device challenge in the local browser and keeps its URL and code visible in the terminal. Complete the challenge, then select a discovered model.
- Disconnecting a borrowed Grok login stores only an Ash-local disconnected flag. Signing in again reconnects a still-valid Grok login without altering its file. An expired Grok access token needs a fresh Ash sign-in unless Grok has renewed the file.
- A failed rotating-token exchange requires signing in again; the submitted refresh token is never reused after an uncertain network result.
- `refresh_account` requests `/user?include=subscription` and Grok Build `/settings` for the current login. The account's displayed plan uses `subscription_tier_display` first, then `subscription_tier`, then the user's `subscriptionTier`; it shows the full value returned by the service rather than a hardcoded tier. `/settings` here is an HTTP endpoint, not an Ash slash command.
- Ash-owned account metadata is saved with its own credential in the profile secret store. For a borrowed Grok login, fetched profile and plan stay in memory, keyed to that file's current access-token revision; a changed token cannot inherit the previous plan. Neither account refresh nor usage reads write `~/.grok/auth.json`. A changed remote user/principal/team or a concurrent local login is rejected.
- `read_subscription` reads the account, access settings, current credit usage and period, exact balances and usage history. `account/rateLimits/read` uses the same displayed plan and exposes the current xAI usage separately from ChatGPT windows; `/usage` displays both signed-in subscriptions and requests fresh usage when opened.
- Metadata refresh never changes the local login ID or credential revision. Token rotation retains account metadata. Each backend read observes cancellation and checks the login before and after network work; only a 401 permits one credential recovery.
- Account data requests include the caller's current token and compatibility headers; after profile discovery, proxy requests also carry the confirmed `x-userid` and optional `x-email`.

## Client compatibility

- OAuth and proxy requests send `x-grok-client-version: 1.0.38`, the Grok Build release whose wire contract this adapter targets. Its provenance is the [`xai-grok-version` manifest](https://github.com/xai-org/grok-build/blob/4247f661689354b831191f11eeeac8424993fe3d/crates/codegen/xai-grok-version/Cargo.toml).
- Product attribution remains `x-grok-client-identifier: ash` and `User-Agent: Ash/<Ash version>`; Ash's package version is independent of the Grok Build compatibility target.
- This is an adapter compatibility policy, not an official third-party protocol-version guarantee. Review the upstream request contract and run the live subscription test before changing the target; a 426 response does not trigger version probing or authentication refresh.

## Live subscription verification

- Run `just test ash-model-provider live_grok_auth_is_read_only_and_uses_the_ash_model_pipeline -- --ignored --nocapture` to check an existing login in `~/.grok/auth.json`.
- The test uses only the access token in an in-memory secret store, loads the account model catalog, and requests a short marker from `grok-4.6` with low reasoning.
- It does not copy the refresh token, refresh credentials, or write Grok authentication. It checks that the source file remains unchanged; expired credentials must be renewed by Grok.
- The September 22, 2026 live check passed account model discovery and the `grok-4.6` / low Responses request, returning `ASH_AUTH_OK` with Grok authentication unchanged. Separating the Grok Build `1.0.38` compatibility target from Ash's `0.1.0` product version resolved the earlier HTTP 426.
- This live check verifies existing-token authentication and generation; interactive device login and token refresh remain covered by isolated tests.

Contract checked against [xAI's Grok Build source](https://github.com/xai-org/grok-build/tree/4247f661689354b831191f11eeeac8424993fe3d) and [official Build documentation](https://docs.x.ai/build/enterprise). The [gRPC API](https://docs.x.ai/developers/grpc-api-reference) describes the API-key service; it is not the transport used by this subscription integration.

- Read-only live account/credits check: `just test ash-xai live_subscription_backend -- --ignored --nocapture`. It uses only Grok’s existing access token in memory and verifies that Grok authentication is unchanged.
