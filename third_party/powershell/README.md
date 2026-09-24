# PowerShell runtime

Ash first uses the Windows-provided `powershell.exe`. A Windows release that
requires PowerShell 7 semantics may stage a pinned `pwsh.exe` runtime here with
verified download checksums, license notices, and release signing.

Do not add `pwsh.exe` to source control. The terminal/process capability must
resolve an approved absolute executable path and remain behind Ash's approval
and sandbox boundary.
