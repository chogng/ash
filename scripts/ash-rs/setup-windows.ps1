<#
  Set up the Windows toolchain used to build the Ash Rust workspace.

  By default, this script checks the environment without installing tools or building.
  Pass -Install to install:
  - Visual Studio 2022 Build Tools with MSVC and the Windows SDK
  - The Rust toolchain declared by rust-toolchain.toml
  - Git, ripgrep, just, CMake, LLVM/Clang, and Python

  Usage from the repository root:
    powershell -ExecutionPolicy Bypass -File scripts/ash-rs/setup-windows.ps1

  Visual Studio Build Tools installation may require an elevated PowerShell.
#>

param(
  [switch] $Install
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$WingetArguments = @(
  '--accept-package-agreements',
  '--accept-source-agreements',
  '--exact'
)

function Test-Command([string] $Name) {
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Assert-ExitCode([string] $Operation) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Operation failed with exit code $LASTEXITCODE"
  }
}

function Assert-InstallerExitCode([string] $Operation) {
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) {
    throw "$Operation failed with exit code $LASTEXITCODE"
  }
}

function Test-WingetPackage([string] $Id) {
  & winget list --id $Id --exact --accept-source-agreements | Out-Null
  return $LASTEXITCODE -eq 0
}

function Install-WingetPackage(
  [string] $Id,
  [string] $Description
) {
  if (Test-WingetPackage $Id) {
    Write-Host "-- Using installed $Description" -ForegroundColor DarkCyan
    return
  }

  Write-Host "-- Installing $Description" -ForegroundColor DarkCyan
  $Arguments = @('install') + $WingetArguments + @('--id', $Id)
  & winget @Arguments | Out-Host
  Assert-InstallerExitCode "winget install $Id"
}

function Refresh-ProcessPath {
  $MachinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $PathEntries = @($MachinePath, $UserPath, $env:Path) |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  $env:Path = $PathEntries -join ';'
}

function Add-ProcessPath([string] $Directory) {
  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
    return
  }

  if (($env:Path -split ';') -notcontains $Directory) {
    $env:Path = "$env:Path;$Directory"
  }
}

function Get-HostArchitecture {
  if (
    $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64' -or
    $env:PROCESSOR_ARCHITECTURE -eq 'ARM64'
  ) {
    return 'arm64'
  }
  return 'x64'
}

function Assert-Python {
  if (-not (Test-Command 'python')) {
    throw 'Python was not found on PATH after prerequisite installation'
  }

  $VersionText = & python -c 'import sys; print(".".join(map(str, sys.version_info[:3])))'
  Assert-ExitCode 'Python version check'
  try {
    $Version = [version]$VersionText
  }
  catch {
    throw "Python returned an invalid version: $VersionText"
  }
  if ($Version -lt [version]'3.11') {
    throw "Python 3.11 or newer is required; found $Version"
  }
}

function Install-VisualStudioComponents([string[]] $Components) {
  $Installer = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vs_installer.exe"
  $VsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) {
    throw "Visual Studio Installer is missing after Build Tools installation: $Installer"
  }
  if (-not (Test-Path -LiteralPath $VsWhere -PathType Leaf)) {
    throw "vswhere is missing after Build Tools installation: $VsWhere"
  }

  $InstallationPath = & $VsWhere -latest -products Microsoft.VisualStudio.Product.BuildTools -version '[17.0,18.0)' -property installationPath
  if (-not $InstallationPath) {
    throw 'Visual Studio 2022 Build Tools installation was not found'
  }

  $Arguments = @(
    'modify',
    '--installPath', $InstallationPath,
    '--quiet',
    '--norestart',
    '--nocache'
  )
  foreach ($Component in $Components) {
    $Arguments += @('--add', $Component)
  }

  Write-Host "-- Ensuring Visual Studio components: $($Components -join ', ')" -ForegroundColor DarkCyan
  & $Installer @Arguments | Out-Host
  Assert-InstallerExitCode 'Visual Studio component installation'
}

$ToolchainDocument = Get-Content -LiteralPath (Join-Path $RepositoryRoot 'rust-toolchain.toml') -Raw
$ToolchainMatch = [regex]::Match($ToolchainDocument, '(?m)^\s*channel\s*=\s*"([^"]+)"\s*$')
if (-not $ToolchainMatch.Success) {
  throw 'rust-toolchain.toml does not declare a channel'
}
$Toolchain = $ToolchainMatch.Groups[1].Value

function Test-Environment {
  $Problems = [Collections.Generic.List[string]]::new()
  foreach ($Entry in @(
    @('git', 'Git.Git'),
    @('rg', 'BurntSushi.ripgrep.MSVC'),
    @('just', 'Casey.Just'),
    @('cmake', 'Kitware.CMake'),
    @('clang', 'LLVM.LLVM')
  )) {
    $Command = $Entry[0]
    try {
      if (-not (Test-Command $Command)) { throw 'not found on PATH' }
      & $Command --version | Out-Null
      Assert-ExitCode "$Command version check"
      Write-Host "OK: $Command"
    }
    catch {
      $Problems.Add("${Command}: $_. Install: winget install --exact --id $($Entry[1])")
    }
  }
  try {
    Assert-Python
    Write-Host 'OK: Python'
  }
  catch {
    $Problems.Add("Python: $_. Install: winget install --exact --id Python.Python.3.12")
  }

  try {
    if (-not (Test-Command 'rustup')) { throw 'rustup not found on PATH' }
    $Installed = & rustup toolchain list
    Assert-ExitCode 'Rust toolchain list'
    if (-not ($Installed | Where-Object { $_ -match "^$([regex]::Escape($Toolchain))(-|\s|$)" })) {
      throw "toolchain $Toolchain is not installed"
    }
    & rustup run $Toolchain rustc --version | Out-Host
    Assert-ExitCode 'Rust compiler check'
    & rustup run $Toolchain cargo --version | Out-Host
    Assert-ExitCode 'Cargo check'
  }
  catch {
    $Problems.Add("Rust: $_. Install rustup, then run: rustup toolchain install $Toolchain --profile minimal --component clippy --component rustfmt")
  }

  $VsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  try {
    if (-not (Test-Path -LiteralPath $VsWhere -PathType Leaf)) { throw 'vswhere not found' }
    $Architecture = Get-HostArchitecture
    $Tools = if ($Architecture -eq 'arm64') { 'Microsoft.VisualStudio.Component.VC.Tools.ARM64' } else { 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' }
    $VisualStudio = & $VsWhere -latest -products '*' -version '[17.0,18.0)' -requires $Tools -property installationPath
    Assert-ExitCode 'Visual Studio check'
    if (-not $VisualStudio) { throw 'MSVC tools were not found' }
    $KitsRoot = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' -Name KitsRoot10).KitsRoot10
    $Sdk = Get-ChildItem -LiteralPath (Join-Path $KitsRoot 'Include') -Directory | Where-Object {
      (Test-Path -LiteralPath (Join-Path $_.FullName 'um\Windows.h')) -and
      (Test-Path -LiteralPath (Join-Path $KitsRoot "Lib\$($_.Name)\um\$Architecture\kernel32.lib"))
    } | Select-Object -First 1
    if (-not $Sdk) { throw "Windows SDK headers and $Architecture libraries were not found" }
    Write-Host "OK: Visual Studio at $VisualStudio"
  }
  catch {
    $Problems.Add("Visual Studio: $_. Use Visual Studio Installer to add the C++ build tools and Windows SDK, or run this script with -Install.")
  }

  # Run pnpm outside the repository so its version manager cannot install the project pin.
  Push-Location ([IO.Path]::GetTempPath())
  try {
    $NodeVersion = (Get-Content -LiteralPath (Join-Path $RepositoryRoot '.nvmrc') -Raw).Trim()
    $PackageManager = (Get-Content -LiteralPath (Join-Path $RepositoryRoot 'package.json') -Raw | ConvertFrom-Json).packageManager
    foreach ($Entry in @(@('node', "v$NodeVersion"), @('pnpm', ($PackageManager -split '@')[-1]))) {
      try {
        if (-not (Test-Command $Entry[0])) { throw 'not found on PATH' }
        $Actual = & $Entry[0] --version
        Assert-ExitCode "$($Entry[0]) version check"
        if ($Actual -ne $Entry[1]) { throw "expected $($Entry[1]), found $Actual" }
        Write-Host "OK: $($Entry[0]) $Actual"
      }
      catch {
        $Problems.Add("$($Entry[0]): $_. See README.md Quick start (Node $NodeVersion; npm install -g $PackageManager).")
      }
    }
  }
  finally { Pop-Location }

  if ($Problems.Count -gt 0) {
    foreach ($Problem in $Problems) { Write-Host "MISSING: $Problem" }
    throw "Environment check failed: $($Problems.Count) issue(s). No build was started."
  }
  Write-Host 'Environment checks passed. Run builds from a Visual Studio Developer PowerShell matching the target architecture.' -ForegroundColor Green
  Write-Host 'Start a product explicitly: just ash, just ash-desktop, or just app.'
}

if ($Install) {
  if (-not (Test-Command 'winget')) {
    throw 'winget is required. Install App Installer from Microsoft Store and rerun this script.'
  }

  Write-Host '==> Installing Windows build prerequisites' -ForegroundColor Cyan

  Install-WingetPackage -Id 'Microsoft.VisualStudio.2022.BuildTools' -Description 'Visual Studio 2022 Build Tools'

  $VisualStudioComponents = @(
    'Microsoft.VisualStudio.Workload.VCTools',
    'Microsoft.VisualStudio.Component.Windows11SDK.22000'
  )
  if ((Get-HostArchitecture) -eq 'arm64') {
    $VisualStudioComponents += @(
      'Microsoft.VisualStudio.Component.VC.Tools.ARM64',
      'Microsoft.VisualStudio.Component.VC.Tools.ARM64EC'
    )
  }
  Install-VisualStudioComponents $VisualStudioComponents

  Install-WingetPackage -Id 'Rustlang.Rustup' -Description 'rustup'
  Install-WingetPackage -Id 'Git.Git' -Description 'Git'
  Install-WingetPackage -Id 'BurntSushi.ripgrep.MSVC' -Description 'ripgrep'
  Install-WingetPackage -Id 'Casey.Just' -Description 'just'
  Install-WingetPackage -Id 'Kitware.CMake' -Description 'CMake'
  Install-WingetPackage -Id 'LLVM.LLVM' -Description 'LLVM and Clang'
  Install-WingetPackage -Id 'Python.Python.3.12' -Description 'Python 3.12'

  Refresh-ProcessPath
  Add-ProcessPath (Join-Path $env:USERPROFILE '.cargo\bin')
  & rustup toolchain install $Toolchain --profile minimal | Out-Host
  Assert-ExitCode "rustup toolchain install $Toolchain"
  & rustup component add clippy rustfmt --toolchain $Toolchain | Out-Host
  Assert-ExitCode "rustup component add for $Toolchain"
}

Test-Environment
