#Requires -Version 5.1
<#
.SYNOPSIS
Inspect or bootstrap a local Windows development account's OpenSSH over Tailscale.
.EXAMPLE
.\scripts\setup-windows-ssh.ps1 -Action Setup -ClientAddress 100.64.0.10 -PublicKey 'ssh-ed25519 AAAA...'
#>
[CmdletBinding()]
param(
    [ValidateSet('Status', 'Diagnose', 'Setup')][string]$Action = 'Status',
    [string]$ClientAddress,
    [string]$PublicKey
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-TailscaleAddress([string]$Address) {
    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed) -or
        $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
        $parsed.ToString() -cne $Address) {
        throw 'Use a single canonical Tailscale IPv4 address.'
    }
    $bytes = $parsed.GetAddressBytes()
    if ($bytes[0] -ne 100 -or $bytes[1] -lt 64 -or $bytes[1] -gt 127) {
        throw 'The address must belong to the Tailscale IPv4 range (100.64.0.0/10).'
    }
}

function ConvertTo-PublicKey([string]$Value) {
    # Accept a public key, never a private key, options, or multiple key lines.
    if ($Value -notmatch '\Assh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?\z') {
        throw 'Supply one OpenSSH Ed25519 public key line.'
    }
    $encoded = $Matches[1]
    $bytes = [Convert]::FromBase64String($encoded)
    $prefix = [Convert]::FromBase64String('AAAAC3NzaC1lZDI1NTE5AAAAIA==')
    if ($bytes.Length -ne 51) { throw 'Invalid Ed25519 public key length.' }
    for ($index = 0; $index -lt $prefix.Length; $index++) {
        if ($bytes[$index] -ne $prefix[$index]) { throw 'Invalid Ed25519 public key encoding.' }
    }
    return "ssh-ed25519 $encoded"
}

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program exited with code $LASTEXITCODE." }
}

function Get-ActiveConfig([string]$Value) {
    return (($Value -split '\r?\n' | ForEach-Object { $_.Trim() } |
        Where-Object { $_ -and -not $_.StartsWith('#') }) -join "`n")
}

function Get-SshDiagnostics([string]$SshDirectory, [string]$ProgramDirectory) {
    # Inspect only SSH metadata and its own events. Never include private key bytes.
    $paths = @($SshDirectory, (Join-Path $SshDirectory 'logs'), (Join-Path $SshDirectory 'sshd_config'))
    $paths += @('rsa', 'ecdsa', 'ed25519') | ForEach-Object { Join-Path $SshDirectory "ssh_host_$($_)_key" }
    $permissions = foreach ($path in $paths) {
        if (Test-Path -LiteralPath $path) {
            try {
                $acl = Get-Acl -LiteralPath $path
                [ordered]@{ path = $path; owner = $acl.Owner; access = $acl.AccessToString }
            } catch { [ordered]@{ path = $path; error = $_.Exception.Message } }
        } else { [ordered]@{ path = $path; missing = $true } }
    }
    $events = foreach ($channel in @('OpenSSH/Admin', 'OpenSSH/Operational')) {
        try {
            Get-WinEvent -LogName $channel -MaxEvents 8 -ErrorAction Stop |
                Select-Object TimeCreated, Id, LevelDisplayName, Message
        } catch { [ordered]@{ channel = $channel; error = $_.Exception.Message } }
    }
    $versions = foreach ($name in @('sshd.exe', 'ssh.exe', 'libcrypto.dll')) {
        $path = Join-Path $ProgramDirectory $name
        if (Test-Path -LiteralPath $path) {
            (Get-Item -LiteralPath $path).VersionInfo | Select-Object FileName, FileVersion, ProductVersion
        }
    }
    # Windows PowerShell turns stderr into error records; retain it as diagnostic
    # data instead of letting a failing config check abort the rest of the report.
    $ErrorActionPreference = 'Continue'
    $validation = (& (Join-Path $ProgramDirectory 'sshd.exe') -t 2>&1 | Out-String).Trim()
    $validationExit = $LASTEXITCODE
    $hostKey = Join-Path $SshDirectory 'ssh_host_ed25519_key.pub'
    $fingerprint = if (Test-Path -LiteralPath $hostKey) {
        (& (Join-Path $ProgramDirectory 'ssh-keygen.exe') -lf $hostKey 2>&1 | Out-String).Trim()
    } else { 'Missing Ed25519 host public key' }
    return [ordered]@{
        computer = $env:COMPUTERNAME
        account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        os = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber
        service = Get-CimInstance Win32_Service -Filter "Name = 'sshd'" |
            Select-Object Name, State, StartMode, StartName, PathName, ExitCode, ServiceSpecificExitCode
        configCheck = [ordered]@{ exitCode = $validationExit; output = $validation }
        hostFingerprint = $fingerprint
        versions = @($versions)
        permissions = @($permissions)
        events = @($events)
        addresses = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '100.*' } |
            Select-Object IPAddress, InterfaceAlias, AddressState)
        listening = @(Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue |
            Select-Object LocalAddress, LocalPort, OwningProcess)
    }
}

function Set-PrivateAcl([string]$Path, [bool]$Directory) {
    # SIDs work on localized Windows; only SYSTEM and Administrators may edit keys.
    $acl = if ($Directory) { New-Object System.Security.AccessControl.DirectorySecurity } else {
        New-Object System.Security.AccessControl.FileSecurity
    }
    $acl.SetAccessRuleProtection($true, $false)
    $administrators = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $acl.SetOwner($administrators)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)
        $inheritance = if ($Directory) { 'ContainerInherit, ObjectInherit' } else { 'None' }
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $identity, 'FullControl', $inheritance, 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

if ($env:OS -ne 'Windows_NT') { throw 'Run this script on Windows.' }
$tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
$tailscalePath = if ($tailscale) { $tailscale.Source } else { Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe' }
if (-not (Test-Path -LiteralPath $tailscalePath -PathType Leaf)) { throw 'Install and sign in to Tailscale first.' }
$status = (Invoke-Checked $tailscalePath @('status', '--json') | Out-String) | ConvertFrom-Json
if ($status.BackendState -ne 'Running') { throw 'Tailscale must be connected first.' }
$serverAddress = @($status.Self.TailscaleIPs | Where-Object { $_ -notmatch ':' })[0]
Assert-TailscaleAddress $serverAddress
$sshDirectory = Join-Path $env:ProgramData 'ssh'
$configPath = Join-Path $sshDirectory 'sshd_config'
$managedDirectory = Join-Path $sshDirectory 'ash-remote-dev'
$marker = '# Managed by Ash scripts/setup-windows-ssh.ps1'
$service = Get-Service -Name sshd -ErrorAction SilentlyContinue
$openSshDirectory = Join-Path $env:SystemRoot 'System32\OpenSSH'

if ($Action -eq 'Diagnose') {
    Get-SshDiagnostics $sshDirectory $openSshDirectory | ConvertTo-Json -Depth 6
    return
}

if ($Action -eq 'Status') {
    [ordered]@{
        computer = $env:COMPUTERNAME
        account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        tailscaleAddress = $serverAddress
        sshService = if ($service) { [string]$service.Status } else { 'NotInstalled' }
        configPath = $configPath
        listening = @(Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue |
            Select-Object LocalAddress, LocalPort, OwningProcess)
    } | ConvertTo-Json -Depth 4
    return
}

Assert-TailscaleAddress $ClientAddress
if ($ClientAddress -eq $serverAddress) { throw 'ClientAddress must identify the Mac, not this Windows host.' }
$key = ConvertTo-PublicKey $PublicKey
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run Setup in an elevated PowerShell window using your Windows development account.'
}
$user = Get-LocalUser -SID $identity.User -ErrorAction Stop
if (-not $user.Enabled -or $user.Name -notmatch '\A[a-zA-Z0-9_.-]+\z') {
    throw 'This bootstrap requires an enabled local account with an ASCII login name without spaces.'
}
$login = $user.Name.ToLowerInvariant()
$defaultConfig = Join-Path $openSshDirectory 'sshd_config_default'
$hostKeyPaths = @('rsa', 'ecdsa', 'ed25519') | ForEach-Object {
    Join-Path $sshDirectory "ssh_host_$($_)_key"
}

# Do not replace an independently configured server or redirect elevated writes.
foreach ($path in (@($sshDirectory, $configPath, $managedDirectory) + $hostKeyPaths + @($hostKeyPaths | ForEach-Object { "${_}.pub" }))) {
    if ((Test-Path -LiteralPath $path) -and
        ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing a reparse point: $path"
    }
}
$existingConfig = ''
if (Test-Path -LiteralPath $configPath) {
    $existingConfig = [IO.File]::ReadAllText($configPath)
    if (-not $existingConfig.StartsWith($marker)) {
        if (-not (Test-Path -LiteralPath $defaultConfig) -or
            (Get-ActiveConfig $existingConfig) -cne (Get-ActiveConfig ([IO.File]::ReadAllText($defaultConfig)))) {
            throw "Existing custom SSH configuration at $configPath; inspect it before choosing a migration."
        }
    }
}
if ($service -and $service.Status -eq 'Running' -and -not $existingConfig.StartsWith($marker)) {
    throw 'An existing SSH server is running. Inspect its users and configuration before migrating it.'
}

$capability = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
if ($capability.State -ne 'Installed') {
    $installation = Add-WindowsCapability -Online -Name $capability.Name
    if ($installation.RestartNeeded) { throw 'OpenSSH installation requires a Windows restart; rerun Setup afterward.' }
}
$sshd = Join-Path $openSshDirectory 'sshd.exe'
$keygen = Join-Path $openSshDirectory 'ssh-keygen.exe'
if (-not (Test-Path -LiteralPath $sshd)) { throw 'The Windows OpenSSH Server executable is missing.' }
$serviceConfiguration = Get-CimInstance Win32_Service -Filter "Name = 'sshd'"
if (-not $serviceConfiguration -or $serviceConfiguration.PathName.Trim('"') -ine $sshd) {
    throw 'The sshd service does not use the standard Windows OpenSSH executable; inspect its configuration first.'
}
New-Item -ItemType Directory -Path $sshDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $managedDirectory -Force | Out-Null
Set-PrivateAcl $managedDirectory $true
$keyPath = Join-Path $managedDirectory 'authorized_keys'
if ((Test-Path -LiteralPath $keyPath) -and
    ((Get-Item -LiteralPath $keyPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Refusing a reparse point: $keyPath"
}
$backupDirectory = Join-Path $managedDirectory ('backup-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backupDirectory | Out-Null
foreach ($path in @($configPath, $keyPath)) {
    if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination $backupDirectory }
}
Write-Host "Configuration backup: $backupDirectory"
$encoding = New-Object System.Text.UTF8Encoding($false)
$configuration = @"
$marker
Port 22
ListenAddress $serverAddress
AllowUsers $login
PubkeyAuthentication yes
PasswordAuthentication no
AuthenticationMethods publickey
AuthorizedKeysFile "$($keyPath.Replace('\', '/'))"
Subsystem sftp "$($openSshDirectory.Replace('\', '/'))/sftp-server.exe"
"@
$candidate = Join-Path $backupDirectory 'candidate.conf'
[IO.File]::WriteAllText($candidate, $configuration + "`n", $encoding)

try {
    Invoke-Checked $keygen @('-A')
    # ssh-keygen run by an administrator can leave host keys owned by that user.
    # The LocalSystem service requires SYSTEM/Administrators ownership and access.
    # Repair only metadata, preserving the host identity clients already verified.
    foreach ($path in $hostKeyPaths) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing host private key: $path" }
        Set-PrivateAcl $path $false
    }
    Invoke-Checked $sshd @('-t', '-f', $candidate)
    [IO.File]::WriteAllText($keyPath, "from=`"$ClientAddress`" $key`n", $encoding)
    Set-PrivateAcl $keyPath $false
    # Bind the daemon to Tailscale as well as limiting the firewall source. Existing
    # broad firewall rules cannot expose this listener on a LAN/public address.
    $ruleName = 'Ash-Remote-Dev-SSH'
    $rule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
    if ($rule) { Remove-NetFirewallRule -Name $ruleName }
    New-NetFirewallRule -Name $ruleName -DisplayName 'Ash development SSH over Tailscale' `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 -Profile Any `
        -LocalAddress $serverAddress -RemoteAddress $ClientAddress -Program $sshd | Out-Null
    $defaultRule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
    if ($defaultRule) { Disable-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' | Out-Null }
    Copy-Item -LiteralPath $candidate -Destination $configPath -Force
    Set-PrivateAcl $configPath $false
    Set-Service -Name sshd -StartupType Automatic
    Restart-Service -Name sshd
    (Get-Service sshd).WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        $runningService = Get-CimInstance Win32_Service -Filter "Name = 'sshd'"
        $listener = @(Get-NetTCPConnection -State Listen -LocalAddress $serverAddress -LocalPort 22 -ErrorAction SilentlyContinue |
            Where-Object { $_.OwningProcess -eq $runningService.ProcessId })
        if ($listener.Count -gt 0) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($listener.Count -eq 0) { throw 'sshd started but its Tailscale listener is absent.' }
} catch {
    $setupFailure = $_.Exception.Message
    # A failed first-use setup must not leave an unexpectedly configured listener.
    Stop-Service -Name sshd -ErrorAction SilentlyContinue
    try {
        Write-Host (Get-SshDiagnostics $sshDirectory $openSshDirectory | ConvertTo-Json -Depth 6)
    } catch { Write-Warning "Could not collect SSH diagnostics: $($_.Exception.Message)" }
    throw "Setup did not complete; sshd has been stopped. Backups: $backupDirectory. $setupFailure"
}

$hostPublicKey = Join-Path $sshDirectory 'ssh_host_ed25519_key.pub'
Write-Host 'Compare this host fingerprint on the Mac before accepting its host key:'
Invoke-Checked $keygen @('-lf', $hostPublicKey)
[ordered]@{
    status = 'listening-awaiting-client-verification'
    account = $login
    address = $serverAddress
    allowedClient = $ClientAddress
    config = $configPath
    backup = $backupDirectory
    next = "ssh -o IdentitiesOnly=yes -i <Mac-private-key-path> $login@$serverAddress whoami"
} | ConvertTo-Json
