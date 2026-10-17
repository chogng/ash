---
name: windows-remote-dev
description: Bootstrap Windows OpenSSH over Tailscale and coordinate Ash development from another host. Use for Windows SSH setup, remote command execution, checkout synchronization, and Windows validation; SSH access alone does not establish Ash Remote runtime support.
---

# Windows remote development

## Establish the management connection

Use Windows OpenSSH over the Tailscale network. Do not assume that `tailscale ssh`
provides a Windows SSH server. Inspect `tailscale status --json` for the intended
host, then test its SSH endpoint. Network reachability alone cannot install a
server; without an existing authenticated management channel, the user must run
the first elevated command on Windows.

The repository helper is [setup-windows-ssh.ps1](../../../scripts/setup-windows-ssh.ps1).
It supports Windows PowerShell 5.1, so installing PowerShell 7 is not a prerequisite
for SSH bootstrap. Its default `Status` action is read-only. For initial setup,
run as the intended local development account in an administrator PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-windows-ssh.ps1 -Action Setup -ClientAddress <Mac-Tailscale-IPv4> -PublicKey '<Mac-Ed25519-public-key>'
```

The helper installs the Windows OpenSSH Server capability if missing, binds port
22 to the Windows Tailscale IPv4 address, permits the specified client address,
and enables public-key authentication for the elevated local account. It keeps
the default SSH command shell; invoke PowerShell explicitly for remote scripts.
It backs up configuration and refuses to replace an independently customized or
running unmanaged server. It does not support domain/Entra bootstrap or local
login names containing spaces/non-ASCII characters; inspect those hosts separately.
An administrator login has administrator authority, so use it only for a host the
user has authorized managing.

Only copy the public key to Windows. Keep machine-specific addresses, usernames,
keys and repository paths out of tracked files. A prepared local handoff can live
under ignored `.build/windows-remote/`. If Taildrop is available, transfer the
script to the exact selected device with `tailscale file cp`; confirm transfer
success separately from execution. Do not use download-and-evaluate one-liners.
For a prefilled handoff script, provide a `Start-Process powershell.exe -Verb RunAs`
launch command with `-NoExit` so the user can accept Windows UAC and retain the
result. Opening an ordinary PowerShell window does not grant administrator access.

If installation succeeds but the service fails to start, use `-Action Diagnose`
before retrying Setup. It reports configuration validation, service identity and
exit codes, OpenSSH events, versions, listener addresses and file ACLs without
reading private key contents. A config check under the elevated user does not
prove that the service account can read host keys or initialize logging.
Host private keys must be owned by SYSTEM or the Administrators group, with access
restricted to those identities. An individual administrator account is not a
substitute for group ownership. Setup repairs those ACLs after `ssh-keygen -A`
without replacing existing keys; preserve the host fingerprint when repairing
permissions. Failed Setup also prints diagnostics before reporting its error.

Validate helper changes with `powershell.exe -NoProfile -File scripts/test-windows-ssh.ps1`
in an elevated Windows session. It checks parsing/input boundaries and repairs a
disposable user-owned file twice, asserting restricted ACLs and unchanged contents.
On other hosts, `pwsh -NoProfile -File scripts/test-windows-ssh.ps1` runs the portable
checks and explicitly skips Windows ACL coverage. Also verify real SSH login and
file transfer after setup; the regression check does not start a service.

Compare the Windows script's Ed25519 host fingerprint with the presented SSH host
key before saving trust. Do not disable host-key checking. Verify `whoami`, then
use `BatchMode=yes`, `IdentitiesOnly=yes`, and the selected key for automation.
Record the verified account, hostname and checkout path in local session context.
The script's `listening-awaiting-client-verification` output does not prove login.
If an existing private key is encrypted, use the user's SSH agent; do not remove
its passphrase. Do not send passwords or private keys through chat or Git.

Tailscale must be connected when sshd starts because the listener binds its address.
After a reboot, check connectivity; if the interface was late, start sshd after
Tailscale is ready. Recheck the binding if the device's Tailscale IP changes.

## Work across the two checkouts

Inspect branch, SHA and dirty state on both hosts before synchronizing. Use the
requested Windows checkout and `git pull --ff-only` only when its branch and clean
state permit it. A dirty/diverged checkout needs a deliberate integration choice;
never use reset, clean or automatic stash to force synchronization. Publish only
the authorized change through the repository commit workflow.

Windows OpenSSH often starts `cmd.exe`. For nontrivial commands, upload a reviewed
PowerShell script and invoke `powershell.exe -NoProfile -File` with correctly quoted
paths. Alternatively encode a reviewed PowerShell command as UTF-16LE for
`-EncodedCommand`; quote literal values before encoding, because encoding is not
shell escaping. Do not assume the SSH working directory is the repository.
Keep protocol and archive bytes out of PowerShell's text pipeline: use inherited
standard handles for child processes. PowerShell 5.1 `ConsoleStream` can deadlock on
OpenSSH input; uploads must use the installer's `FileStream` over the borrowed stdin
handle. Exercise uploads larger than the SSH window, not just tiny archives.
Windows OpenSSH's default `cmd.exe` limits command lines to 8191 characters; use the
existing compressed installer loader or upload a script when encoding exceeds it.
The first Remote handshake can include installing the profile's complete package.
Keep its startup budget distinct from ordinary RPC timeouts, and verify that a
subsequent connection reuses verified package contents before the terminal lease
expires. Successful reinitialization alone does not prove terminal reattachment.

Use [environment setup](../setup-environment/SKILL.md) for missing build inputs and
[Rust development](../rust-development/SKILL.md) for Rust changes. An SSH session
does not inherit a Visual Studio Developer PowerShell environment; select the
installed target architecture's tools before compiling. Preserve command exit
codes, collect output and verify the remote Git SHA with each result. Use dedicated
test profiles instead of the user's Ash data. Service restarts can interrupt other
connections using that profile; inspect their ownership before restarting.

If execution policy blocks an npm-installed PowerShell shim, invoke `pnpm.cmd`
without changing the user's policy. After an authorized pnpm upgrade, verify the
version resolved in a fresh SSH session: `pnpm self-update` can leave an older
npm-owned shim first on PATH, which needs updating in its existing Node prefix.

## Distinguish the product boundary

Before promising a Windows Ash Remote connection, inspect
[the target declaration](../../../remote-server/package.json),
[the package builder](../../../build/remote.py) and
[remote development](../../../docs/remote-development.md). The builder accepts
Windows MSVC x64/ARM64 targets and the installer uses explicit PowerShell commands.
An OpenSSH login
or a Windows App Server build is not proof of Remote bootstrap, installation,
path handling, protocol initialization, terminals, or reconnect support.

Report separately: management SSH verified; exact build/tests run on Windows;
Ash Remote product scenarios actually passed; remaining unsupported boundaries.
