set working-directory := "."
set positional-arguments := true
set shell := ["sh", "-cu"]
set windows-shell := ["pwsh", "-NoLogo", "-NoProfile", "-CommandWithArgs"]

ruff := if os_family() == "windows" { "./scripts/.venv/Scripts/ruff.exe" } else { "./scripts/.venv/bin/ruff" }
tools_python := if os_family() == "windows" { "./scripts/.venv/Scripts/python.exe" } else { "./scripts/.venv/bin/python" }

# Reuse the initialized repository interpreter instead of an older system Python.

python := if path_exists(tools_python) == "true" { tools_python } else if os_family() == "windows" { "python" } else { "python3" }
recipe_args := if os_family() == "windows" { "@($args | Select-Object -Skip 1)" } else { '"$@"' }

# Unit tests and PTY service binaries share one profile to reuse dependency outputs.

tui_profile := "ci-test"
tui_profile_arg := "--profile " + tui_profile

# Format sources with their owning Just, Rust, Python, and frontend tools.
fmt:
    {{ python }} -B scripts/format.py

# Check formatting without modifying files.
fmt-check:
    {{ python }} -B scripts/format.py --check

# Format Rust independently of frontend dependencies.
rust-format:
    {{ python }} -B scripts/format.py --language rust

# Check Rust formatting independently of frontend dependencies.
rust-format-check:
    {{ python }} -B scripts/format.py --language rust --check

# Check Python build and repository tools with the pinned linter.
lint:
    {{ ruff }} check build scripts

# Check Python formatting with the pinned repository formatter.
python-format-check:
    {{ ruff }} format --check build scripts

# Check English spelling in repository sources and documentation.
spellcheck:
    {{ tools_python }} -B scripts/spellcheck.py

# Install the exact Python tool wheels before lint, formatting, or spellcheck.
install-python:
    {{ python }} -B scripts/install_python_tools.py

# Run repository-owned Python tests, optionally selecting scripts, code, or build.
test-python *args:
    {{ python }} -B scripts/test-python.py {{ recipe_args }}

# Show file ownership, matching instructions, and referenced skills.
context *args:
    {{ python }} -B scripts/workflow.py context {{ recipe_args }}

# Check, test, and reject warnings for one Cargo package using one profile.
verify *args:
    {{ python }} -B scripts/workflow.py verify {{ recipe_args }}

# Group TUI snapshots by test; accept only explicitly listed reviewed files.
snapshot *args:
    {{ python }} -B scripts/workflow.py snapshot {{ recipe_args }}

# Reject dependency declaration, ownership, version, and unused-dependency violations.
dependencies *args:
    {{ python }} -B scripts/dependencies.py {{ recipe_args }}

# Measure a selected Cargo package in isolated build directories.
bench-build *args:
    {{ python }} -B scripts/benchmark.py {{ recipe_args }}

# Explicitly trim idle Cargo caches; ordinary builds retain reusable compiler state.
prune-build-cache *args:
    {{ python }} -B -m build.lib.cargo_cache {{ recipe_args }}

# Build the terminal and Electron products from the repository root.
build: build-code build-ash

# Build the Ash Code CLI/TUI host and its development server programs.
build-code:
    {{ python }} -B build/code/build.py

# Build the Ash Electron product.
build-ash:
    pnpm build

# Build the root Rust workspace with the locked V8 inputs when required.
build-rust *args:
    {{ python }} -B scripts/cargo.py build --workspace {{ recipe_args }}

# Test one Rust package. V8 inputs are configured only when its dependency graph needs them.
test *args:
    {{ python }} -B scripts/cargo.py test -p {{ recipe_args }}

# Run selected process integration tests independently of Cargo's Windows Job.
test-processes *args:
    {{ python }} -B scripts/cargo.py --process-tests test -p {{ recipe_args }}

# Run TUI library tests with the shared test profile.
test-tui-unit *args:
    {{ python }} -B scripts/cargo.py test -p ash-tui --lib {{ tui_profile_arg }} {{ recipe_args }}

# Build matching service programs and run real CLI/TUI scenarios through a PTY.
test-tui *args:
    {{ python }} -B scripts/cargo.py build -p ash-app-server --bin ash-app-server -p ash-app-server-daemon --bin ash-app-server-daemon -p ash-remote-server --bin ash-remote-server -p ash-code-mode-host --bin ash-code-mode-host {{ tui_profile_arg }}
    {{ python }} -B scripts/cargo.py test -p ash-cli --test tui_real_scenarios {{ tui_profile_arg }} {{ recipe_args }}

# Check one Rust package. V8 inputs are configured only when its dependency graph needs them.
check *args:
    {{ python }} -B scripts/cargo.py check -p {{ recipe_args }}

# Compile every target in one Rust package and reject compiler warnings.
rust-warnings *args:
    {{ python }} -B scripts/cargo.py --deny-warnings check -p {{ recipe_args }} --all-targets

# Discover and compile every direct consumer of grep and file-search, and their tests.
check-search *args:
    {{ python }} -B scripts/check_search.py {{ recipe_args }}

# Run the Rust search capability and host integration tests.
test-search-rust:
    just test ash-grep -p ash-tgrep -p ash-file-search -p ash-codebase
    just test ash-app-server --lib codebase_
    just test ash-app-server --lib local_tools
    just test ash-app-server --lib server::environment_runtime::tests
    just test ash-app-server --lib server::search_operations::tests

# Validate search consumers, backend behavior, renderer lifecycle, and compiler warnings.
test-search: check-search test-search-rust
    pnpm test:unit --run src/ash/platform/search/test/browser/searchService.test.ts --run src/ash/platform/search/test/browser/browserFileSearchService.test.ts --run src/ash/platform/app-server/test/browser/webRendererApi.test.ts --run src/ash/sessions/test/browser/sessionFileService.test.ts --run src/ash/workbench/contrib/search/test/browser/searchViewPane.test.ts
    pnpm test:browser:integration chatContextActions.integration.spec.ts --project=chromium
    pnpm typecheck:renderer
    just check-search --deny-warnings

# Exercise an assembled package through real stdio RPC, using its bundled search engines.
test-search-package *args:
    {{ python }} -B build/search_smoke.py {{ recipe_args }}

# Fail once the configuration support window makes a compatibility migration removable.
check-config-migrations:
    {{ python }} -B scripts/cargo.py test -p ash-config tests::config_migration_support_window_has_no_expired_compatibility -- --exact

# Refresh the canonical user configuration schema.
generate-config-schema:
    cargo run --quiet -p ash-config-schema -- crates/config/schema.json

# Derive the editable model catalog schema from its Rust parser declarations.
generate-model-catalog-schema *args:
    {{ python }} -B scripts/cargo.py run -p ash-model-provider-info --bin generate-model-catalog-schema -- {{ args }}

# Refresh the checked-in App Server protocol fixtures and generated TypeScript client.
generate-protocol:
    pnpm run protocol:generate

# Launch the Ash Code TUI product from the current source tree.
ash-code *args:
    {{ python }} -B build/code/run.py {{ recipe_args }}

# Preview the Welcome pet's idle frame, all frames, or one named action.
pet *args:
    @{{ python }} -B scripts/cargo.py run --quiet -p ash-sprite -- crates/tui/assets/welcome/pet.sprite {{ args }}

# Assemble the complete immutable development package shared by Ash products.
ash-package *args:
    {{ python }} -B build/prepare.py {{ recipe_args }}

# Assemble the complete development package and launch Ash Code against it.
ash-package-run *args:
    {{ python }} -B build/code/run_package.py {{ recipe_args }}

# Launch the Ash Electron product.
ash:
    pnpm dev

# Build the shared App Server package.
app-server-package *args:
    {{ python }} -B build/app_server.py {{ recipe_args }}

alias runtime-package := app-server-package

# Build the complete Remote package declared by remote/package.json.
remote-package *args:
    {{ python }} -B build/remote.py {{ recipe_args }}

# Compose a managed Code package from a verified runtime package and the ash executable.
code-package *args:
    {{ python }} -B build/code/package.py {{ recipe_args }}

[unix]
install:
    rustup show active-toolchain
    cargo fetch
    just install-python

[windows]
install:
    #!powershell.exe -File
    $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if (-not $pwsh) {
        winget install --exact --id Microsoft.PowerShell --source winget --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    rustup show active-toolchain
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    cargo fetch
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    just install-python
    exit $LASTEXITCODE
