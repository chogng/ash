$ErrorActionPreference = "Stop"
$repository = "chogng/ash"
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$target = switch ($architecture) {
    "X64" { "x86_64-pc-windows-msvc" }
    "Arm64" { "aarch64-pc-windows-msvc" }
    default { throw "Ash Code does not publish a managed package for Windows $architecture." }
}
$archive = "ash-code-$target.tar.gz"
$base = "https://github.com/$repository/releases/latest/download"
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("ash-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    $archivePath = Join-Path $temporary $archive
    $checksumPath = "$archivePath.sha256"
    Invoke-WebRequest -Uri "$base/$archive" -OutFile $archivePath
    Invoke-WebRequest -Uri "$base/$archive.sha256" -OutFile $checksumPath
    $fields = ((Get-Content -Raw $checksumPath).Trim() -split "\s+")
    if ($fields.Count -ne 2 -or $fields[1].TrimStart("*") -ne $archive) {
        throw "The Ash Code checksum file is invalid."
    }
    $actual = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
    if ($actual -ne $fields[0].ToLowerInvariant()) {
        throw "The Ash Code package checksum does not match."
    }
    $package = Join-Path $temporary "package"
    New-Item -ItemType Directory -Path $package | Out-Null
    & tar.exe -xzf $archivePath -C $package
    if ($LASTEXITCODE -ne 0) { throw "Could not extract the Ash Code package." }
    $installRoot = if ($env:ASH_INSTALL_ROOT) { $env:ASH_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA "Ash" }
    $launcherRoot = if ($env:ASH_BIN_DIR) { $env:ASH_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "Microsoft/WindowsApps" }
    # The verified CLI shares its publication lock and atomic selection with updates.
    & (Join-Path $package "bin/ash.exe") install-managed --package $package --install-root $installRoot --bin-dir $launcherRoot
    if ($LASTEXITCODE -ne 0) { throw "Could not publish the Ash Code installation." }
} finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $temporary
}
