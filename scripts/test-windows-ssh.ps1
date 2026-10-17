#Requires -Version 5.1
<#
.SYNOPSIS
Check bootstrap input validation and Windows host-key ACL repair without changing sshd.
.DESCRIPTION
Run with PowerShell on any host for parsing and input checks. On Windows, run as an
administrator to also exercise ACL repair on disposable files, never live SSH keys.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$scriptPath = Join-Path $PSScriptRoot 'setup-windows-ssh.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
# Load only pure validation and ACL helpers; the setup entrypoint changes services.
$names = @('Assert-TailscaleAddress', 'ConvertTo-PublicKey', 'Get-ActiveConfig', 'Set-PrivateAcl')
foreach ($function in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    if ($function.Name -in $names) { . ([scriptblock]::Create($function.Extent.Text)) }
}

foreach ($address in @('100.64.0.1', '100.127.255.254')) {
    Assert-TailscaleAddress $address
}
foreach ($address in @('', '127.0.0.1', '100.63.255.255', '100.128.0.1', '100.064.0.1', '100.64.0.1/32', '::1', "100.64.0.1`nPasswordAuthentication yes")) {
    $rejected = $false
    try { Assert-TailscaleAddress $address } catch { $rejected = $true }
    if (-not $rejected) { throw "Accepted invalid address: $address" }
}

# A synthetic wire-format public key is sufficient for parser checks; no personal key.
$bytes = [Convert]::FromBase64String('AAAAC3NzaC1lZDI1NTE5AAAAIA==') + (New-Object byte[] 32)
$key = 'ssh-ed25519 ' + [Convert]::ToBase64String($bytes)
if ((ConvertTo-PublicKey "$key fixture") -cne $key) { throw 'Public-key comment normalization failed.' }
foreach ($value in @('', "${key}`n${key}", '-----BEGIN OPENSSH PRIVATE KEY-----', ('from="*" ' + $key), 'ssh-ed25519 AAAA', ('ssh-ed25519 ' + [Convert]::ToBase64String((New-Object byte[] 51))))) {
    $rejected = $false
    try { ConvertTo-PublicKey $value | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Accepted invalid public key.' }
}
if ((Get-ActiveConfig "# comment`r`n Port 22 `r`n`r`nPasswordAuthentication no") -cne "Port 22`nPasswordAuthentication no") {
    throw 'Configuration comparison failed.'
}

if ($env:OS -ne 'Windows_NT') {
    Write-Host 'PASS: syntax and input checks. SKIP: Windows ACL regression (requires Windows).'
    return
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run Windows ACL regression checks in an elevated PowerShell session.'
}
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('ash-ssh-acl-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    $fixture = Join-Path $temporary 'host-key-fixture'
    [IO.File]::WriteAllText($fixture, 'disposable fixture, not a private key')
    $before = (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash
    $userAcl = Get-Acl -LiteralPath $fixture
    $userAcl.SetOwner($identity.User)
    $userAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity.User, 'Modify', 'Allow')))
    Set-Acl -LiteralPath $fixture -AclObject $userAcl
    # Reproduce the administrator-owned key created by ssh-keygen, then repair twice.
    if ((Get-Acl -LiteralPath $fixture).GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) {
        throw 'Could not establish the original user-owned fixture.'
    }
    Set-PrivateAcl $fixture $false
    Set-PrivateAcl $fixture $false
    $acl = Get-Acl -LiteralPath $fixture
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544' -or
        -not $acl.AreAccessRulesProtected -or $rules.Count -ne 2) {
        throw 'Host-key ownership or ACL protection is incorrect.'
    }
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $matching = @($rules | Where-Object {
            $_.IdentityReference.Value -eq $sid -and $_.AccessControlType -eq 'Allow' -and
            $_.FileSystemRights -eq 'FullControl' -and -not $_.IsInherited
        })
        if ($matching.Count -ne 1) { throw "Host-key access is incorrect for $sid." }
    }
    if ((Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash -cne $before) {
        throw 'ACL repair changed the key contents.'
    }
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
Write-Host 'PASS: syntax, input checks and Windows ACL regression; file contents preserved across repeated repair.'
