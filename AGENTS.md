# Ash Agent Instructions

## Common rules

- Read [`.github/copilot-instructions.md`](.github/copilot-instructions.md) completely, then all matching files in [`.github/instructions`](.github/instructions). Follow their ownership and dependency rules.
- Follow the [testing guidelines](.github/instructions/testing.instructions.md) for every code change, even when tests are unchanged. Check affected tests and builds.
- Do not use `native` or `projection` in names.
- Comment on reasons, constraints, resource lifetimes, and API rules that the code does not explain.
- Test Web and Electron with Playwright. Debug with runtime behavior and assertions, not screenshots.
- If the user's requested UI style conflicts with an applicable skill, stop and ask the user before next.
- Lead with the conclusion. Use plain language, short explanations, and tables when they clarify comparisons.
- Reserve `✅` and `❌` for binary judgments. Describe partial progress or delegated work in words.

References: `../vscode`, `../codex`, `../zed`, `../warp`, `../marketplace`, `../mxc`, `../tgrep`.

## Only for crates

Design for the intended long-term architecture. Check effects across the system and follow its ownership and dependency rules.

- Give each piece of business state one owner. Keep updates there; avoid competing copies.
- Say when configuration changes apply and who stops tasks and releases resources.
- Make the flow from input to execution to saved results easy to follow, including cancellation and failure handling.
- Before splitting a file or adding a layer, explain its job and what becomes simpler. File size alone is not a reason.
- Keep the same core operation's behavior consistent across clients, using the existing contracts.
