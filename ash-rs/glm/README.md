# GLM Coding Plan account login

`ash-glm` owns two separate interactive accounts: `bigmodel-coding-plan` and `zai-coding-plan`. It first reads an existing ZCode individual Coding Plan account from `~/.zcode/v2/credentials.json` (or `ZCODE_DATA_BASE_DIR/.zcode/v2/credentials.json`). The user does not enter a Coding Plan key.

ZCode credentials are read for each model request and are never copied into Ash or written back. Ash reuses a ZCode subscription only when its account and Coding Plan request key are complete and readable. Otherwise it uses its own saved credential or offers browser authorization and polling, without changing ZCode's file. After authorization, the driver asks `ash-backend-client` to obtain a model request credential from the corresponding provider business API. Only the account ID, optional display metadata, credential revision, and model request credential are saved in the profile `SecretStore`. OAuth poll tokens and account access tokens stay within the login attempt.

`ash-login` owns login IDs, cancellation, account state, and logout. This crate owns the provider protocol and private credential lifecycle. An Ash login can be removed from Ash; a ZCode account must be signed out in ZCode. `ash-model-provider` reads the matching account and request target together for each model invocation. The two accounts never share stored credentials; the `zai` model vendor ID remains shared across their model definitions.

The App Server exposes both through `account/login/start`, `account/read`, `account/logout`, and the existing login completion notifications. Account quota and plan tier are not yet exposed for either provider.
