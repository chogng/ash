# Independent Rust editor extension development

The development SDK contains the Rust SDK, versioned Host RPC types, the client source-digest build helper, TypeScript declarations, a closed-client compiler and a native development host. It does not contain Ash runtime implementations. Its editor API is `editor.client.v1` / client API v1; imports use `ash:editor/<module>.js` and the exported allowlist. Only the runtime exports in `editor-api.json` are callable. Type declarations do not grant runtime authority.

From the Ash checkout, build the development host and export into **new sibling directories**:

```sh
./scripts/.venv/bin/python scripts/cargo.py build -p ash-external-ext --example editor_dev --profile ci-test
pnpm extension:sdk /tmp/ash-sdk /tmp/academy-project .build/cargo/ci-test/examples/editor_dev
```

The exported Academy project owns its sources and document model; the SDK owns contracts and build tooling. Neither Cargo nor TypeScript in that project needs an Ash checkout. Keep the SDK and project at their exported relative locations, or update Cargo paths and `tsconfig.json` after moving them. Install Node dependencies in the SDK, then initialize the project's lockfile and build:

```sh
cd /tmp/ash-sdk
npm install --ignore-scripts
cd /tmp/academy-project
cargo generate-lockfile
node ../ash-sdk/dev.mjs build .
node ../ash-sdk/dev.mjs check .
node ../ash-sdk/dev.mjs debug . --allow-local-code
```

The last command starts the real Rust extension through Ash's Host RPC supervisor. The explicit flag authorizes **trusted local code without OS isolation**; it does not install a package or grant production renderer execution. The host prints registrations, executable digest, stderr, output events and localized client descriptions. Commands on stdin are `status`, `describe zh-CN`, `reload` and `quit`. Rebuild after editing native or browser sources, then reload to activate the new binary/digest. EOF, SIGINT and SIGTERM shut down the supervised process. Protocol stdout is reserved for the SDK; use SDK output channels or stderr for diagnostics. Native breakpoints may be configured in a developer's Rust debugger; automatic privileged debugger attachment is not part of this workflow.

`client` rebuilds only the browser resources. `build` builds native code, typechecks and compiles client resources; `check` runs Rust tests and TypeScript checking. Both native build.rs and the browser compiler hash the same sorted browser/common TS/CSS sources. A stale native binary is rejected when its client source digest differs from the installed resources.

Package a completed debug build for this machine (use the actual target platform):

```sh
node ../ash-sdk/dev.mjs package . /tmp/academy-submission darwin-arm64
```

The output is a neutral market submission with per-platform executable and client resources, not a signed installable package. Registry tooling validates and signs it; the ordinary Ash package manager then installs it and requests exact execution authorization. Packaging refuses to replace an existing output. The SDK does not contain publisher keys, bypass signing or change production trust. Cross-platform releases require building and validating each target binary; the repository `package:editor` entry accepts multiple platform binaries.

Academy, Reference Manager and PDF Viewer remain independent optional capabilities. This editor-client API is for admitted editor clients; it is not a general renderer service container or a claim that arbitrary third-party UI clients are sandboxed. Backend extensions use the Rust SDK and Host RPC; MCP and Skills are other capability forms within the user-facing “extension” concept. Agent structured document editing has its own model/version/permission contract and is not supplied by exporting these development APIs.

## Verified scope (2026-10-20)

On macOS arm64, Academy was exported to a temporary directory outside the checkout, installed its own Node dependencies, generated its own Cargo lockfile and completed `build` plus `check` with Cargo offline. The exported project contains its process integration test; it registered English and Chinese descriptions and rejected invalid requests. The SDK's 19 unit/process tests and Academy's repository verification passed. Eight build-tool tests cover portable declarations, closed resources, public/private imports and immutable submissions; three opt-in development tests cover authorization, invocation/reload, stale source rejection and SIGTERM cleanup.

The independent executable and compiled resources also passed six Chromium integration scenarios, including English/Chinese writing, citations, replacement/retirement, clipboard and history. Twenty-two targeted editor unit tests passed. The same independent build was packaged, signed with temporary test keys, verified and installed through the real Manager/Product launcher test: execution before consent was denied, exact consent admitted it, revocation stopped it and uninstall retired its resources. Temporary private signing keys and the isolated Ash selfhosting credential reference were removed. No online publication or live user profile installation was performed.

Ash selfhosting implemented the SDK document-client contract and its validation tests in `.build/extension-sdk-selfhost`; parent verification is recorded in `.build/extension-sdk-delivery` (including `location.json`, `validation.json`, development/build/browser/signing logs and `installation.log`). The native dev host normal build, Rust warning check, dependency check and selected TypeScript checks passed. The existing Host unit suite initially had one failure in its Node local-peer TCP-close assertion; its other 57 tests passed, and that exact test passed on the single bounded rerun. The browser build retained its existing vendored WASM/eval and color-environment warnings.

This covers this machine's native process host, real package installation and Chromium client loader. Native breakpoint attachment, a new Electron “Extension Development Window”, cross-platform binaries and Electron multi-window/Remote acceptance were not exercised or supplied by this SDK workflow. Existing platform/assistive-technology acceptance tasks remain in the repository TODO; these results do not close them.
