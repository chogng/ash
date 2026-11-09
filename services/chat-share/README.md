# Ash conversation share service

Ash Desktop publishes an immutable snapshot of the selected conversation branch after confirmation. The snapshot contains committed user and assistant messages and voice transcript text. Markdown and available message timestamps are preserved. The request carries neither Ash account credentials nor tool records, attachment bytes, or backend identifiers.

The Worker accepts `POST /v1/shares` with a version 1 JSON snapshot, up to 10 MiB and 10,000 messages. It returns `201 Created` with a relative `Location: /s/<id>`. Anyone with that URL can view the snapshot for 30 days in a normal browser. The Worker serves a script-free page and rate-limits publishing. The source conversation and the snapshot have independent lifetimes.

Use `bun test services/chat-share/worker.test.ts` from the repository root. For local desktop testing, run `npx wrangler dev --config services/chat-share/wrangler.jsonc --ip 127.0.0.1` and set `sessions.chat.shareServiceUrl` to the printed HTTP origin in the local user settings.

## Deployment

The desktop default is `https://ash-chat-share.lanxiang0901.workers.dev`. Deploy using a Cloudflare account with access to that Worker namespace and R2 enabled. For another namespace, set the desktop share service URL to its HTTPS origin.

```sh
npx wrangler r2 bucket create ash-chat-shares
npx wrangler r2 bucket lifecycle add ash-chat-shares expire-shares shares/ --expire-days 30
npx wrangler deploy --config services/chat-share/wrangler.jsonc
```

Keep the R2 bucket private. The Worker is the read path, so it can enforce expiration and apply response headers. Verify the published service by creating a share from a synthetic Ash conversation and opening the copied link in a separate browser profile. See the [R2 commands](https://developers.cloudflare.com/workers/wrangler/commands/r2/) and [rate limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
