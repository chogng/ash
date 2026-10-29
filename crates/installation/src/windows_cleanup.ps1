param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$sandboxRoot = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'AshWindowsSandbox'
$runtime = Join-Path (Join-Path $sandboxRoot 'runtimes') $sid
$removeRuntime = $request.removeSandbox -and (Test-Path -LiteralPath $runtime)
$inspectService = $request.removeSandbox -and (Test-Path -LiteralPath (Join-Path $sandboxRoot 'bin/ash-windows-sandbox-service.exe'))
$retained = @()
if (-not $request.removeSandbox -and (Test-Path -LiteralPath $sandboxRoot)) { $retained += $sandboxRoot }
$rules = @(Get-NetFirewallRule -ErrorAction Stop | Where-Object {
    $_.Name -like 'TCP Query User*' -or $_.Name -like 'UDP Query User*'
} | ForEach-Object {
    $rule = $_
    $program = ($rule | Get-NetFirewallApplicationFilter).Program
    if ($program -and $program -match '^(?:[a-zA-Z]:\\|\\\\)' -and [IO.Path]::GetFileName($program) -match '^(?:Ash|ash[-_]app[-_]server(?:-[0-9a-f]+)?)\.exe$') {
        $full = [IO.Path]::GetFullPath($program)
        foreach ($root in $request.roots) {
            $prefix = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
            if ($full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                $rule
                break
            }
        }
    }
})
$administrator = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (($rules.Count -or $inspectService) -and -not $administrator) {
    throw 'Run the uninstaller as administrator under the same Windows account to remove the recorded system resources.'
}
if ($removeRuntime) {
    $runner = Join-Path $request.bin 'ash-windows-sandbox.exe'
    $service = Join-Path $request.bin 'ash-windows-sandbox-service.exe'
    $plan = & $runner plan remove | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or ($plan.changes.ownerSid -and $plan.changes.ownerSid -ne $sid) -or $plan.changes.runtimeDirectory -ne $runtime -or $plan.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid sandbox removal plan.' }
    & $runner remove --approve $plan.sha256 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not remove the current user sandbox runtime.' }
}
if ($inspectService) {
    $service = Join-Path $request.bin 'ash-windows-sandbox-service.exe'
    # The service owns every other user's runtime. Its own validated uninstall
    # operation refuses removal while any of those runtimes remain.
    $servicePlan = & $service plan uninstall | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $servicePlan.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid sandbox service removal plan.' }
    if (@($servicePlan.changes.runtimes).Count -eq 0) {
        & $service uninstall --approve $servicePlan.sha256 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not remove the unused sandbox service.' }
    } else { $retained += $sandboxRoot }
}
foreach ($rule in $rules) { $rule | Remove-NetFirewallRule -ErrorAction Stop }
ConvertTo-Json -InputObject @($retained) -Compress
