param(
    [Parameter(Mandatory)][ValidateSet('x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc')][string]$Target,
    [ValidateNotNullOrEmpty()][string]$WslDistribution,
    [ValidateNotNullOrEmpty()][string]$NetworkDnsServer,
    [ValidateNotNullOrEmpty()][string]$NetworkPublicIpv6Http
)
$ErrorActionPreference = 'Stop'
if ($NetworkPublicIpv6Http -and !$NetworkDnsServer) { throw 'Public IPv6 acceptance requires the DNS matrix.' }
if ($NetworkPublicIpv6Http) { $env:ASH_PUBLIC_IPV6_HTTP_ENDPOINT = $NetworkPublicIpv6Http }
$workspace = Split-Path -Parent $PSScriptRoot
$output = Join-Path $workspace ".build/acceptance/windows-sandbox-$Target"
New-Item -ItemType Directory -Force -Path $output | Out-Null

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}

# The caller must run this explicit acceptance entry point as an administrator.
# Normal product execution never invokes setup or requests elevation.
Invoke-Checked python @('-B', 'scripts/cargo.py', 'build', '-p', 'ash-windows-sandbox', '--bin', 'ash-windows-sandbox', '--locked', '--target', $Target)
Invoke-Checked python @('-B', 'scripts/cargo.py', 'build', '-p', 'ash-windows-sandbox-service', '--bin', 'ash-windows-sandbox-service', '--locked', '--target', $Target)
Invoke-Checked python @('-B', 'scripts/cargo.py', 'build', '-p', 'ash-network-proxy', '--example', 'probe', '--locked', '--target', $Target)
if ($NetworkDnsServer) {
    Invoke-Checked python @('-B', 'scripts/cargo.py', 'build', '-p', 'ash-network-proxy', '--example', 'matrix', '--locked', '--target', $Target)
    $env:ASH_NETWORK_MATRIX_PROBE = Join-Path $workspace ".build/cargo/$Target/debug/examples/matrix.exe"
    $env:ASH_DNS_SERVER = $NetworkDnsServer
}
$bin = Join-Path $output 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$binary = Join-Path $bin 'ash-windows-sandbox.exe'
Copy-Item -LiteralPath (Join-Path $workspace ".build/cargo/$Target/debug/ash-windows-sandbox.exe") -Destination $binary
$service = Join-Path $bin 'ash-windows-sandbox-service.exe'
Copy-Item -LiteralPath (Join-Path $workspace ".build/cargo/$Target/debug/ash-windows-sandbox-service.exe") -Destination $service
$env:ASH_WINDOWS_SANDBOX_BIN = $binary
$env:ASH_NETWORK_PROBE = Join-Path $workspace ".build/cargo/$Target/debug/examples/probe.exe"
$servicePlanFile = Join-Path $output 'service-install-plan.json'
& $service plan install | Set-Content -LiteralPath $servicePlanFile -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare service installation plan.' }
$servicePlan = Get-Content -LiteralPath $servicePlanFile -Raw | ConvertFrom-Json
$serviceRoot = $servicePlan.changes.serviceDirectory
if ((Test-Path -LiteralPath $serviceRoot) -or (Get-Service -Name 'AshWindowsSandbox' -ErrorAction SilentlyContinue)) {
    throw 'An Ash sandbox service already exists; refusing to adopt or remove it.'
}
$root = $null
$setupAttempted = $false
$failure = $null
try {
    Invoke-Checked $service @('install', '--approve', $servicePlan.sha256)
    $setupFile = Join-Path $output 'setup-plan.json'
    & $binary plan setup --slots 1 | Set-Content -LiteralPath $setupFile -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare installation plan.' }
    $plan = Get-Content -LiteralPath $setupFile -Raw | ConvertFrom-Json
    $root = $plan.changes.runtimeDirectory
    if (Test-Path -LiteralPath $root) { throw 'A sandbox installation already exists; refusing to adopt or remove it.' }
    $setupAttempted = $true
    Invoke-Checked $binary @('setup', '--slots', '1', '--approve', $plan.sha256)
    $blockedUninstallFile = Join-Path $output 'service-blocked-uninstall-plan.json'
    & $service plan uninstall | Set-Content -LiteralPath $blockedUninstallFile -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare occupied service removal plan.' }
    $blockedUninstall = Get-Content -LiteralPath $blockedUninstallFile -Raw | ConvertFrom-Json
    & $service uninstall --approve $blockedUninstall.sha256
    if ($LASTEXITCODE -eq 0) { throw 'Service removal accepted a remaining user runtime.' }
    Invoke-Checked $binary @('status')
    Invoke-Checked python @('-B', 'scripts/cargo.py', 'test', '-p', 'ash-windows-sandbox-service', '--locked', '--target', $Target)
    Invoke-Checked python @('-B', 'scripts/cargo.py', 'test', '-p', 'ash-windows-sandbox', '--lib', '--test', 'windows', '--locked', '--target', $Target, '--', '--include-ignored', '--nocapture', '--test-threads=1')
    if ($NetworkDnsServer) {
        Invoke-Checked python @('-B', 'scripts/cargo.py', '--process-tests', 'test', '-p', 'ash-windows-sandbox', '--test', 'network_matrix', '--locked', '--target', $Target, '--', '--ignored', '--nocapture', '--test-threads=1')
    }
    if ($WslDistribution) {
        $env:ASH_WSL_DISTRO = $WslDistribution
        Invoke-Checked python @('-B', 'scripts/cargo.py', 'test', '-p', 'ash-windows-sandbox', '--test', 'wsl', '--locked', '--target', $Target, '--', '--ignored', '--test-threads=1')
    }
    $beforeFile = Join-Path $output 'before-update-plan.json'
    & $binary plan remove | Set-Content -LiteralPath $beforeFile -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw 'Could not read account identities before update.' }
    $before = Get-Content -LiteralPath $beforeFile -Raw | ConvertFrom-Json
    # A PE overlay changes the approved executable identity without replacing
    # the worker protocol. Only this disposable acceptance copy is changed.
    $stream = [IO.File]::Open($binary, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.WriteByte(1) } finally { $stream.Dispose() }
    $updateFile = Join-Path $output 'update-plan.json'
    & $binary plan update | Set-Content -LiteralPath $updateFile -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare executable update plan.' }
    $update = Get-Content -LiteralPath $updateFile -Raw | ConvertFrom-Json
    if ($update.changes.runnerSha256 -eq $before.changes.runnerSha256) { throw 'Update did not change the executable identity.' }
    Invoke-Checked $binary @('update', '--approve', $update.sha256)
    $afterFile = Join-Path $output 'after-update-plan.json'
    & $binary plan remove | Set-Content -LiteralPath $afterFile -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect updated account identities.' }
    $after = Get-Content -LiteralPath $afterFile -Raw | ConvertFrom-Json
    if (($before.changes.accounts | ConvertTo-Json -Depth 10 -Compress) -ne ($after.changes.accounts | ConvertTo-Json -Depth 10 -Compress)) { throw 'Update changed the provisioned accounts.' }
    if (($before.changes.networkObjects | ConvertTo-Json -Depth 30 -Compress) -ne ($after.changes.networkObjects | ConvertTo-Json -Depth 30 -Compress)) { throw 'Update changed the installed network objects.' }
    Invoke-Checked python @('-B', 'scripts/cargo.py', 'test', '-p', 'ash-windows-sandbox', '--test', 'windows', '--locked', '--target', $Target, '--', '--include-ignored', '--test-threads=1')
    $stream = [IO.File]::Open($service, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.WriteByte(1) } finally { $stream.Dispose() }
    $serviceUpdateFile = Join-Path $output 'service-update-plan.json'
    & $service plan install | Set-Content -LiteralPath $serviceUpdateFile -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare service executable update plan.' }
    $serviceUpdate = Get-Content -LiteralPath $serviceUpdateFile -Raw | ConvertFrom-Json
    if ($serviceUpdate.changes.serviceSha256 -eq $serviceUpdate.changes.installedServiceSha256) { throw 'Service update did not change the executable identity.' }
    Invoke-Checked $service @('install', '--approve', $serviceUpdate.sha256)
    Invoke-Checked $binary @('status')
    $afterServiceFile = Join-Path $output 'after-service-update-plan.json'
    & $binary plan remove | Set-Content -LiteralPath $afterServiceFile -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect accounts after service update.' }
    $afterService = Get-Content -LiteralPath $afterServiceFile -Raw | ConvertFrom-Json
    if (($after.changes.accounts | ConvertTo-Json -Depth 10 -Compress) -ne ($afterService.changes.accounts | ConvertTo-Json -Depth 10 -Compress)) { throw 'Service update changed the provisioned accounts.' }
    if (($after.changes.networkObjects | ConvertTo-Json -Depth 30 -Compress) -ne ($afterService.changes.networkObjects | ConvertTo-Json -Depth 30 -Compress)) { throw 'Service update changed the installed network objects.' }
    Invoke-Checked python @('-B', 'scripts/cargo.py', 'test', '-p', 'ash-windows-sandbox', '--test', 'windows', '--locked', '--target', $Target, 'scoped_execution_preserves_grants_metadata_and_exit_code_authenticity', '--', '--ignored', '--exact', '--test-threads=1')
} catch {
    $failure = $_
} finally {
    if ($setupAttempted -and $root -and (Test-Path -LiteralPath $root)) {
        $removeFile = Join-Path $output 'remove-plan.json'
        & $binary plan remove | Set-Content -LiteralPath $removeFile -Encoding utf8
        if ($LASTEXITCODE -ne 0) { throw 'Could not read installation recovery plan.' }
        $removal = Get-Content -LiteralPath $removeFile -Raw | ConvertFrom-Json
        Invoke-Checked $binary @('remove', '--approve', $removal.sha256)
    }
    if (Test-Path -LiteralPath $serviceRoot) {
        $serviceRemoveFile = Join-Path $output 'service-uninstall-plan.json'
        & $service plan uninstall | Set-Content -LiteralPath $serviceRemoveFile -Encoding utf8
        if ($LASTEXITCODE -ne 0) { throw 'Could not prepare service cleanup plan.' }
        $serviceRemoval = Get-Content -LiteralPath $serviceRemoveFile -Raw | ConvertFrom-Json
        Invoke-Checked $service @('uninstall', '--approve', $serviceRemoval.sha256)
    }
}
if ($failure) { throw $failure }
