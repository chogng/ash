# Inputs are quoted by the trusted host; stdin contains only the verified archive.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$lock = $null
$staging = $null

function Fail($code, $status = 73) {
    [Console]::WriteLine('__ASH_REMOTE_RUNTIME_INSTALL_ERROR__:' + $code)
    exit $status
}

function CheckPath($path) {
    for ($current = $path; $current; $current = [IO.Path]::GetDirectoryName($current)) {
        if ((Test-Path -LiteralPath $current) -and
            ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Fail 'reparse-point'
        }
    }
}

function Report($kind) {
    [Console]::WriteLine('__ASH_REMOTE_RUNTIME_' + $kind + '__:' + $digest + ':' + $executable.Replace('\', '/'))
}

try {
    if (!$root) {
        if (!$env:LOCALAPPDATA) { Fail 'install-root-unavailable' }
        $root = Join-Path $env:LOCALAPPDATA 'Ash\remote'
    }
    $parent = Join-Path $root ('runtimes\' + $target + '\' + $version)
    CheckPath $parent
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $runtime = Join-Path $parent $digest
    $executable = Join-Path $runtime 'bin\ash-remote-server.exe'
    $receipt = Join-Path $runtime '.ash-remote-runtime-sha256'
    $lockPath = $runtime + '.installing'
    CheckPath $lockPath
    try { $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
    catch [IO.IOException] { Fail 'install-in-progress' 75 }
    # Keep the lock file: deleting it after releasing the handle races a new installer.
    CheckPath $executable
    CheckPath $receipt
    if ((Test-Path -LiteralPath $executable -PathType Leaf) -and
        (Test-Path -LiteralPath $receipt -PathType Leaf) -and
        [IO.File]::ReadAllText($receipt).Trim() -ceq $digest) {
        Report 'REUSED'
        exit 0
    }
    if (Test-Path -LiteralPath $runtime) { Fail 'incomplete-runtime' }
    if (!(Get-Command tar.exe -CommandType Application -ErrorAction SilentlyContinue)) { Fail 'tar-unavailable' 69 }
    $staging = Join-Path $parent ('.staging-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($staging) | Out-Null
    # Match POSIX umask 077 for new content, including caller-selected install roots.
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($user)
    foreach ($sid in @($user.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
    }
    [IO.Directory]::SetAccessControl($staging, $acl)
    $archive = Join-Path $staging 'package.tar.gz'
    $package = Join-Path $staging 'package'
    [IO.Directory]::CreateDirectory($package) | Out-Null
    # ConsoleStream can deadlock on OpenSSH's stdin pipe once its window fills.
    # Use a FileStream over the borrowed handle, as PowerShell's SSH remoting does.
    # https://github.com/PowerShell/PowerShell/issues/14478
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class AshRemoteInput {
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int which);
    public static Stream Open() {
        IntPtr handle = GetStdHandle(-10);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return new FileStream(new SafeFileHandle(handle, false), FileAccess.Read);
    }
}
'@
    $inputBytes = [AshRemoteInput]::Open()
    $output = [IO.File]::Open($archive, 'CreateNew', 'Write', 'None')
    try {
        $buffer = New-Object byte[] 65536
        $size = 0L
        while (($count = $inputBytes.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $size += $count
            if ($size -gt $expectedSize) { Fail 'archive-size-mismatch' 65 }
            $output.Write($buffer, 0, $count)
        }
    } finally { $output.Dispose(); $inputBytes.Dispose() }
    if ($size -ne $expectedSize) { Fail 'archive-size-mismatch' 65 }
    $hash = [Security.Cryptography.SHA256]::Create()
    $file = [IO.File]::OpenRead($archive)
    try { $observed = [BitConverter]::ToString($hash.ComputeHash($file)).Replace('-', '').ToLowerInvariant() }
    finally { $file.Dispose(); $hash.Dispose() }
    if ($observed -cne $digest) { Fail 'archive-sha256-mismatch' 65 }
    & tar.exe -xzf $archive -C $package
    if ($LASTEXITCODE -ne 0) { Fail 'archive-extraction-failed' 65 }
    foreach ($relative in @('ash-package.json', 'bin/ash-remote-server.exe', 'bin/ash-app-server.exe', 'bin/ash-app-server-daemon.exe', 'ash-path/rg.exe', 'ash-resources/tgrep/tgrep.exe', 'ash-resources/node/bin/node.exe')) {
        if (!(Test-Path -LiteralPath (Join-Path $package $relative) -PathType Leaf)) { Fail 'package-entrypoint-missing' 65 }
    }
    [IO.File]::WriteAllText((Join-Path $package '.ash-remote-runtime-sha256'), $digest, (New-Object Text.UTF8Encoding($false)))
    [IO.Directory]::Move($package, $runtime)
    Report 'INSTALLED'
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    Fail 'installation-failed'
} finally {
    if ($staging -and (Test-Path -LiteralPath $staging)) { [IO.Directory]::Delete($staging, $true) }
    if ($lock) { $lock.Dispose() }
}
