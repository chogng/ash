$ErrorActionPreference = 'Stop'
$manifest = Join-Path $PSScriptRoot 'standalone/Cargo.toml'
cargo test --offline --manifest-path $manifest
