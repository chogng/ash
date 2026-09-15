set working-directory := "."
set positional-arguments

export JUST_SHELL := justfile_directory() / "scripts/just-shell.py"

set shell := ["python3", "-c", 'import os, runpy; runpy.run_path(os.environ["JUST_SHELL"], run_name="__main__")']
set windows-shell := ["python", "-c", 'import os, runpy; runpy.run_path(os.environ["JUST_SHELL"], run_name="__main__")']

python := if os_family() == "windows" { "python" } else { "python3" }
tui_profile := ""
tui_profile_arg := if tui_profile == "" { "" } else { "--profile " + tui_profile }

# Format Just, Rust, and first-party Python sources.
fmt:
    {{ python }} -B scripts/format.py

# Check formatting without modifying files.
fmt-check:
    {{ python }} -B scripts/format.py --check

# Run repository-owned Python tests, optionally selecting scripts, ash-code, or build.
test-python *args:
    uv run --frozen --project scripts python -B scripts/test-python.py {args}

# Reject dependency declaration, ownership, version, and unused-dependency violations.
dependencies *args:
    uv run --frozen --project scripts python -B scripts/dependencies.py {args}

# Measure a selected Cargo package in isolated build directories.
bench-build *args:
    uv run --frozen --project scripts python -B scripts/benchmark.py {args}

# Build all three product lines from the repository root.
build: build-desktop build-rust

# Build the Electron Desktop product.
build-desktop:
    pnpm --dir ash-ts build

# Build the root Rust workspace with the locked V8 inputs when required.
build-rust *args:
    {{ python }} -B scripts/cargo.py build --workspace {args}

# Test one Rust package. V8 inputs are configured only when its dependency graph needs them.
test *args:
    {{ python }} -B scripts/cargo.py test -p {args}

# Build the matching daemon and run real CLI/TUI scenarios through a PTY.
test-tui *args:
    {{ python }} -B scripts/cargo.py build -p ash-app-server --bin ash-app-server -p ash-app-server-daemon --bin ash-app-server-daemon -p ash-remote-server --bin ash-remote-server {{ tui_profile_arg }}
    {{ python }} -B scripts/cargo.py test -p ash-cli --test tui_real_scenarios {{ tui_profile_arg }} {args}

# Check one Rust package. V8 inputs are configured only when its dependency graph needs them.
check *args:
    {{ python }} -B scripts/cargo.py check -p {args}

# Compile every target in one Rust package and reject compiler warnings.
rust-warnings *args:
    {{ python }} -B scripts/cargo.py --deny-warnings check -p {args} --all-targets

# Fail once the configuration support window makes a compatibility migration removable.
check-config-migrations:
    {{ python }} -B scripts/cargo.py test -p ash-config tests::config_migration_support_window_has_no_expired_compatibility -- --exact

# Refresh the canonical user configuration schema.
generate-config-schema:
    cargo run --quiet -p ash-config-schema -- ash-rs/config/schema.json

# Refresh the checked-in App Server protocol fixtures and generated TypeScript client.
generate-protocol:
    cargo run --quiet -p ash-app-server-protocol --bin generate_protocol -- fixtures
    pnpm --dir ash-ts run protocol:generate

# Launch the ash code TUI product from the current source tree.
ash *args:
    {{ python }} -B scripts/ash-code/run.py {args}

# Preview the Welcome pet's idle frame, all frames, or one named action.
pet *args:
    @{{ python }} -B scripts/cargo.py run --quiet -p ash-sprite -- ash-code/tui/assets/welcome/pet.sprite {{ args }}

# Assemble the complete immutable development package shared by Ash products.
ash-package *args:
    node build/package/prepare.ts {args}

# Assemble the complete development package and launch Ash Code against it.
ash-package-run *args:
    {{ python }} -B scripts/ash-code/run_package.py {args}

# Launch the ash Electron Desktop product.
ash-desktop:
    pnpm --dir ash-ts dev

# Launch the pure-Rust app Desktop product.
app:
    {{ python }} -B scripts/cargo.py build -p ash-app-server --bin ash-app-server
    {{ python }} -B scripts/cargo.py run -p app

# Check every pure-Rust app target with the locked sandbox-enabled V8 inputs.
app-check:
    {{ python }} -B scripts/cargo.py check -p app --all-targets

# Test every pure-Rust app target with the locked sandbox-enabled V8 inputs.
app-test:
    {{ python }} -B scripts/cargo.py test -p app --all-targets

# Stage an unsigned app package; release CI signs and verifies the staged binary.
app-package *args:
    {{ python }} -B build/app/build.py {args}

# Build a canonical Ash package; pass normal package builder flags.
package *args:
    {{ python }} -B build/package/build.py {args}

[unix]
install:
    rustup show active-toolchain
    cargo fetch
    uv sync --frozen --project scripts

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
    uv sync --frozen --project scripts
    exit $LASTEXITCODE
