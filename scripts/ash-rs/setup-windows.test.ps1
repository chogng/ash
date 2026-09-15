$ErrorActionPreference = 'Stop'
$Setup = Join-Path $PSScriptRoot 'setup-windows.ps1'
$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$NodeVersion = (Get-Content (Join-Path $RepositoryRoot '.nvmrc') -Raw).Trim()
$PnpmVersion = ((Get-Content (Join-Path $RepositoryRoot 'package.json') -Raw | ConvertFrom-Json).packageManager -split '@')[-1]
$Toolchain = [regex]::Match((Get-Content (Join-Path $RepositoryRoot 'rust-toolchain.toml') -Raw), 'channel\s*=\s*"([^"]+)"').Groups[1].Value
$global:SetupCalls = [Collections.Generic.List[string]]::new()
$global:SetupHasRust = $false

function git { $global:LASTEXITCODE = 0 }
function rg { $global:LASTEXITCODE = 0 }
function just { $global:LASTEXITCODE = 0 }
function cmake { $global:LASTEXITCODE = 0 }
function clang { $global:LASTEXITCODE = 0 }
function python { $global:LASTEXITCODE = 9009 }
function node { $global:LASTEXITCODE = 0; "v$NodeVersion" }
function pnpm {
  if ((Get-Location).Path -eq $RepositoryRoot) { throw 'pnpm must be checked outside the repository' }
  $global:SetupCalls.Add("pnpm $args")
  $global:LASTEXITCODE = 0
  $PnpmVersion
}
function rustup {
  $global:SetupCalls.Add("rustup $args")
  $global:LASTEXITCODE = 0
  if (($args -join ' ') -eq 'toolchain list') {
    if ($global:SetupHasRust) { "$Toolchain-x86_64-pc-windows-msvc" }
    return
  }
  if (($args -join ' ') -notin @("run $Toolchain rustc --version", "run $Toolchain cargo --version")) {
    throw "Unexpected rustup operation: $args"
  }
}
function winget { $global:SetupCalls.Add('INSTALL'); throw 'Installation must be explicit' }
function cargo { $global:SetupCalls.Add('BUILD'); throw 'Setup must not build' }
function Test-Path {
  param($LiteralPath, $PathType)
  if ($LiteralPath -like '*vswhere.exe') { return $false }
  Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath
}

foreach ($HasRust in @($false, $true)) {
  $global:SetupHasRust = $HasRust
  $global:SetupCalls.Clear()
  $Before = (Get-Location).Path
  $Output = @()
  try { & $Setup 6>&1 | ForEach-Object { $Output += $_ } }
  catch { $Output += $_ }
  $Text = $Output -join "`n"
  foreach ($Expected in @('Python version check failed', 'Visual Studio:', 'Environment check failed')) {
    if (-not $Text.Contains($Expected)) { throw "Missing diagnostic: $Expected`n$Text" }
  }
  if (-not $HasRust -and -not $Text.Contains("toolchain $Toolchain is not installed")) {
    throw 'Missing Rust toolchain was not reported'
  }
  $ExpectedCalls = @('rustup toolchain list')
  if ($HasRust) { $ExpectedCalls += @("rustup run $Toolchain rustc --version", "rustup run $Toolchain cargo --version") }
  $ExpectedCalls += 'pnpm --version'
  if (($global:SetupCalls -join '|') -ne ($ExpectedCalls -join '|')) { throw "Unexpected tool calls: $global:SetupCalls" }
  if ((Get-Location).Path -ne $Before) { throw 'Setup changed the caller working directory' }
}
Write-Host 'Passed 2 setup scenarios: aggregate diagnostics, no implicit installation/build, and directory restoration.'
