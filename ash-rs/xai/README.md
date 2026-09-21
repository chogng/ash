# ash-xai

- Own xAI subscription device authorization and cancellation.
- Store and refresh Ash-owned credentials through the secret store.
- Resolve authenticated Grok CLI proxy requests per invocation.
- Keep subscription credentials separate from API keys and Grok CLI storage.

## Subscription transport

- Device authorization uses `auth.x.ai/oauth2/device/code` and `auth.x.ai/oauth2/token`.
- Inference uses `https://cli-chat-proxy.grok.com/v1/responses` over HTTP/SSE; account models come from `/models-v2`.
- `xai-subscription` is separate from the `xai` API-key provider. Ash stores credentials in its profile secret store and coordinates refreshes through the profile's `xai.lock`.
- Start from Ash Code's `/config` → Providers → xAI Subscription. Complete the browser device challenge, then select a discovered model.
- A failed rotating-token exchange requires signing in again; the submitted refresh token is never reused after an uncertain network result.
- Account email, plan details, and subscription usage reporting are not queried by this integration.

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
