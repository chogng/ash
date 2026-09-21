#Requires -Version 7.0
# Uses the same Rust adapter as Ash; no SDK backend dispatcher or account setup.
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$output = Join-Path $workspace '.build/acceptance/psec'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$report = [ordered]@{
    status = 'incomplete'
    stage = 'inventory'
    commit = $env:GITHUB_SHA
    runnerImage = $env:ImageVersion
    scope = 'PSEC preparation, scoped files, exit codes, process cleanup, cross-execution isolation; Managed refusal'
    notCovered = @('PSEC ConPTY', 'Allowed/Denied network traffic matrix', 'App Server product chain', 'WSL')
    commands = @()
}

function Invoke-Test([string]$Name, [string]$Program, [string[]]$Arguments) {
    $log = Join-Path $output "$Name.log"
    "$Program $($Arguments -join ' ')" | Set-Content -LiteralPath $log
    & $Program @Arguments 2>&1 | Tee-Object -FilePath $log -Append | Out-Host
    $code = $LASTEXITCODE
    $report.commands += [ordered]@{ name = $Name; exitCode = $code; log = "$Name.log" }
    if ($code -ne 0) { throw "$Name failed (exit $code); see $log" }
    # The test harness can succeed with zero matches after a rename.
    if ($Arguments -contains '--exact') {
        if ((Get-Content -LiteralPath $log -Raw) -notmatch 'test result: ok\. 1 passed; 0 failed; 0 ignored;') {
            throw "$Name did not execute exactly one acceptance test"
        }
    }
}

Push-Location $workspace
try {
    $report.os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture
    $report.build = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' |
        Select-Object DisplayVersion, CurrentBuild, UBR
    $report.mxc = Get-Content 'ash-rs/vendor/mxc/upstream.json' -Raw | ConvertFrom-Json
    $report.toolchain = (& rustc -Vv | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Rust toolchain unavailable' }
    $report.python = (& python --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Python unavailable (a Windows Store alias is insufficient)' }
    $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    if (-not (Test-Path -LiteralPath $powershell -PathType Leaf)) { throw 'Windows PowerShell workload is missing' }
    $report.stage = 'build'
    $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $output 'report.json') -Encoding utf8
    # Build once, then run these exact executables for every acceptance phase.
    & python -B scripts/cargo.py test -p ash-mxc-sandbox --lib --test windows --locked --no-run --message-format=json `
        2> (Join-Path $output 'build.log') | Set-Content -LiteralPath (Join-Path $output 'build.jsonl') -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw "Test build failed; see $output/build.log" }
    $artifacts = @(Get-Content -LiteralPath (Join-Path $output 'build.jsonl') | ForEach-Object {
        $message = $_ | ConvertFrom-Json
        if ($message.reason -eq 'compiler-artifact' -and $message.executable -and $message.profile.test) {
            $message
        }
    })
    $unit = @($artifacts | Where-Object { $_.target.name -eq 'mxc_sandbox' })
    $windows = @($artifacts | Where-Object { $_.target.name -eq 'windows' })
    if ($unit.Count -ne 1 -or $windows.Count -ne 1) { throw 'Expected exactly one library and one Windows acceptance executable' }
    $report.binaries = @($unit[0].executable, $windows[0].executable) | ForEach-Object { Get-FileHash -LiteralPath $_ -Algorithm SHA256 }
    $report.stage = 'regressions'
    Invoke-Test 'unit' $unit[0].executable @('--nocapture')
    Invoke-Test 'regressions' $windows[0].executable @('--nocapture')
    $report.stage = 'capability'
    Invoke-Test 'capability' $windows[0].executable @('psec_host_supports_scoped_policy', '--ignored', '--exact', '--nocapture')
    $report.stage = 'execution'
    foreach ($test in @(
        'scoped_execution_preserves_grants_metadata_and_exit_code_authenticity',
        'timeout_and_cancellation_terminate_descendants',
        'subsequent_executions_cannot_write_files_owned_by_an_earlier_execution',
        'ordinary_exit_reaps_background_descendants'
    )) {
        Invoke-Test $test $windows[0].executable @($test, '--ignored', '--exact', '--nocapture')
    }
    $report.status = 'passed-listed-scope'
    $report.stage = 'complete'
} catch {
    $report.status = 'failed'
    $report.error = $_.Exception.Message
    throw
} finally {
    $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $output 'report.json') -Encoding utf8
    if ($env:GITHUB_STEP_SUMMARY) {
        @(
            '## Windows PSEC acceptance',
            "Status: **$($report.status)**; stage: **$($report.stage)**.",
            '',
            "Scope: $($report.scope).",
            '',
            "Not covered: $($report.notCovered -join ', ').",
            '',
            'A failed capability probe is not a skipped or passed acceptance test. See the evidence artifact.'
        ) | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY
    }
    Pop-Location
}
