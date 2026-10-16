# ash-language

Owns canonical source-language identities and built-in file associations. The same
`extensions/*/package.json` language declarations used by the Editor generate the
backend association catalogue. `tree-sitter/grammars.json` contributes legacy grammar-ID
bindings, such as `shell` → `shellscript`; parser identity remains separate.

`LanguageId::parse` validates IDs at persistence, configuration and protocol boundaries.
Valid external IDs survive unchanged even when no built-in parser supports them.
`detect_language` consumes a path and optional first line without reading files. Filename,
glob, suffix and first-line precedence matches the Editor and is checked against the same
`test/fixtures/languages/associations.json` corpus in both runtimes.

Codebase scanning and materialization use these associations. Codebase stores persist the
canonical ID; `ash-syntax::SyntaxLanguage::for_language` independently selects parser
support. LSP coordination uses the same ID validation. Document text, editing-rule
registration and user overrides, provider registration, LSP processes and syntax trees
keep their existing owners.

The generator also reads each language contribution's JSONC configuration file. Its
`folding.markers` and `folding.offSide` produce Rust rules and the Worker configuration
in `languageFolding.generated.ts`. `folding_rules` classifies region lines for Rust;
the Worker receives the same package rules from its runtime loader. Languages without
markers have no implicit region syntax. Off-side indentation folds include trailing
blank lines; other indentation folds stop at the final nonblank line. Parser structural
folds keep their existing priority. Both runtimes verify edits and undo against
`test/fixtures/languages/folding.json`.

Run `pnpm language:generate` after changing language declarations. Preparation regenerates
the catalogue; `pnpm language:generate --check` rejects stale output. Run
`just verify ash-language` to check the Rust contract and shared association cases.
