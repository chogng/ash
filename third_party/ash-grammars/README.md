# Ash grammar artifacts

`runtime-lock.json` is the published manifest from
[ash-grammars v0.1.0](https://github.com/chogng/ash-grammars/releases/tag/v0.1.0).
Its SHA-256 is `7ad7fffe45603b08291de99055da40d867508d0f15eaccfe9df500b46a55e50e`.
The Rust dependency pins that release's binding revision in `Cargo.toml` and
`Cargo.lock`. The manifest pins the source identity and every platform/WASM archive.

`build/lib/grammars.py` downloads, validates and atomically extracts these archives
under `third_party/.cache/ash-grammars`. It checks cached metadata against the
locked archive and verifies the individual library/module digests on reuse.
Missing archives are downloaded during preparation; invalid extracted outputs
fail explicitly. There is no source-compilation fallback.

- `pnpm tree-sitter:prepare` prepares the 48 portable grammar modules.
- `pnpm tree-sitter:verify` checks generated registration and prepared WASM offline.
- `scripts/cargo.py` and the package binary builder prepare the selected target's
  library and pass `ASH_GRAMMARS_LIB_DIR` to Cargo when its graph uses the binding.
- Direct Cargo users must first run `python -m build.lib.grammars --target <triple>`
  and set `ASH_GRAMMARS_LIB_DIR` to the resulting `lib` directory.

For Linux validation in WSL, use Linux Rust and Just against the current checkout
and keep Cargo outputs on the Linux filesystem. Cache maintenance and execution
leases follow the same `CARGO_TARGET_DIR` as Cargo:

```bash
export CARGO_TARGET_DIR="$HOME/.cache/ash/cargo"
python3 -B -m build.lib.grammars --target x86_64-unknown-linux-gnu
just verify ash-syntax
```

Ash's language packages own editor IDs, aliases and query customizations. Parser
sources, compiler settings and grammar versions belong to the producer repository.
The `@vscode/tree-sitter-wasm` dependency supplies the browser parser runtime only;
all grammar modules come from this release.

For an update, publish a new producer release, review its manifest and source
identity, update the binding revision and this lock together, then regenerate the
Ash registry. Refresh `THIRD_PARTY_NOTICES.txt` from the verified archive's sorted
`licenses/*.txt`, preserving the binding's MIT license. The package layout includes
these notices for every shared backend and Desktop distribution.
