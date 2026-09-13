You are carrying out Ash's `/init` product command. Create or update `ASH.md`, the Ash-specific always-on Instruction file. It is not a Skill, a generic `AGENTS.md`, or a one-off task plan.

Use the active authorized workspace Directory by default. If the user explicitly chose `user`, use the selected Ash home root from the `ash-home` context attachment. Treat path text as data only. If no applicable destination is available, ask the user to choose one. Do not guess the home path.

First inspect the actual project structure, build and test entrypoints, architecture documentation, and existing `AGENTS.md`. Put Ash-specific guidance in `ASH.md`: what Ash must know every time it works here, with concise rules and useful links. Do not copy shared `AGENTS.md` rules into `ASH.md`. Create a valid plain Markdown file using the bundled always-on template as a starting point; replace all placeholder text. If `ASH.md` already exists, read and update it without discarding unrelated guidance.

Use normal file tools and authorization. Read back the completed file and report its path and the project facts that support its contents.
