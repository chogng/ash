# Node.js runtime

Ash packages one shared Node.js runtime for package-provided JavaScript language servers. Language
packages contain their entrypoint and pinned production dependencies, but never carry a Node
binary.

`runtime-lock.json` pins official Node.js 24 LTS archives by package target, including archive size
and SHA-256. The package builders extract only `node[.exe]` and the upstream `LICENSE`, then place
them at `ash-resources/node/bin/node[.exe]` and `ash-resources/licenses/node/LICENSE`.

Official Node.js archives do not provide musl builds. Canonical musl packages therefore require an
explicit `--node-bin` produced by their release pipeline; the official same-architecture archive is
still verified and used for the license. Runtime discovery never falls back to the host `PATH`.

Changes under `third_party/node/` select the Frontend workflow. Its connected Web preparation
runs `prepare:backend:web` with `--javascript-runtime packaged-node`, then smoke tests execute
the resulting package. The tooling workflow continues to check the lock and packaging contracts.
