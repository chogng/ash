import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Supervised development helpers inherit the worker's private POSIX group. */
export function detachedProcess(environment: NodeJS.ProcessEnv = process.env): boolean {
	return process.platform !== 'win32' && environment.ASH_DEV_PROCESS_SUPERVISED !== '1';
}

/** Checks OS liveness; an exited Windows process can retain a table entry while handles remain open. */
export function isProcessRunning(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
		if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
		throw error;
	}
}

interface ProcessIdentity {
	readonly pid: number;
	readonly parent: number;
	readonly group?: number;
	readonly started: string;
}

interface RunResource {
	process?: ProcessIdentity;
	daemon?: { readonly executable: string; readonly profile: string; };
}

/** Registers resources that can outlive their owning worker, before they start. */
export async function registerRunResource(daemon?: RunResource['daemon'] | (() => NonNullable<RunResource['daemon']>), directory = process.env.ASH_SMOKE_RUN_DIRECTORY): Promise<{ process(child: ChildProcess): Promise<void>; dispose(): Promise<void>; }> {
	const path = directory ? join(directory, `resource-${randomUUID()}.json`) : undefined;
	// Other launcher consumers can prepare their package during launch. Resolve
	// the pre-launch executable only for a prepared process run that owns cleanup.
	const resource: RunResource = { daemon: directory ? typeof daemon === 'function' ? daemon() : daemon : undefined };
	const save = async (): Promise<void> => {
		if (!path) return;
		// Cancellation may read the registry while a worker registers its process.
		await writeFile(`${path}.tmp`, JSON.stringify(resource));
		await rename(`${path}.tmp`, path);
	};
	await save();
	return {
		process: async child => {
			if (!path || !child.pid) return;
			resource.process = (await processes()).get(child.pid);
			await save();
		},
		dispose: async () => { if (path) await rm(path, { force: true }); },
	};
}

/** Owns runner commands and cancellation, including detached product resources. */
export class ProcessRun {
	// Retain completed roots too: helpers may keep their process group alive.
	private readonly children = new Map<ChildProcess, Promise<void>>();
	private closing: Promise<void> | undefined;
	private finishGrace: (() => void) | undefined;
	private readonly owned = new Map<number, ProcessIdentity>();
	private readonly windowsProcessTable = process.platform === 'win32' ? new WindowsProcessTable() : undefined;
	private readonly registrations: Awaited<ReturnType<typeof registerRunResource>>[] = [];
	public stopped = false;

	private readonly cwd: string;
	private readonly directory: string | undefined;
	private readonly graceMs: number;
	constructor(cwd: string, directory?: string, graceMs = 45_000) { this.cwd = cwd; this.directory = directory; this.graceMs = graceMs; }

	public async command(command: string, args: readonly string[], env: NodeJS.ProcessEnv, capture = false): Promise<{ code: number; output: string; }> {
		if (this.stopped) throw new Error('Process run was stopped; refusing to start another command.');
		const child = spawn(command, args, { cwd: this.cwd, env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', detached: detachedProcess(env), windowsHide: true });
		let output = '';
		child.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
		const result = new Promise<{ code: number; output: string; }>((resolveExit, reject) => {
			child.once('error', reject);
			child.once(capture ? 'close' : 'exit', (code, signal) => resolveExit({ code: signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : code ?? 1, output }));
		});
		this.children.set(child, result.then(() => undefined, () => undefined));
		// Retain every command for cleanup even if metadata collection fails or
		// its root exits while descendants still hold the process group.
		await this.rememberTree();
		await this.register(child);
		return await result;
	}

	public async own(child: ChildProcess): Promise<void> {
		if (this.stopped) throw new Error('Process run was stopped; refusing to own another process.');
		let spawnError: Error | undefined;
		child.once('error', error => { spawnError = error; });
		this.children.set(child, child.exitCode !== null || child.signalCode !== null || !child.pid
			? Promise.resolve() : new Promise<void>(resolveExit => { child.once('exit', () => resolveExit()); child.once('error', () => resolveExit()); }));
		await this.rememberTree();
		await this.register(child);
		if (spawnError) throw spawnError;
	}

	private async register(child: ChildProcess): Promise<void> {
		// The independent supervisor also needs roots that use separate groups,
		// and Windows has no POSIX group to retain after a worker is killed.
		if (process.env.ASH_DEV_PROCESS_SUPERVISED !== '1' || !child.pid) return;
		const resource = await registerRunResource();
		this.registrations.push(resource);
		await resource.process(child);
	}

	public stop(signal: NodeJS.Signals): Promise<void> {
		if (this.closing) { this.finishGrace?.(); return this.closing; }
		this.stopped = true;
		const interruptedAgain = new Promise<void>(resolveGrace => { this.finishGrace = resolveGrace; });
		return this.closing = (async () => {
			const errors: unknown[] = [];
			try { await this.rememberTree(); } catch (error) { errors.push(error); }
			// Playwright first stops scheduling and runs fixture teardown. Electron
			// and managed daemons have separate process groups, so a group signal alone
			// cannot clean the run. Retain their identities before the worker exits.
			for (const child of this.children.keys()) {
				if (child.pid && child.exitCode === null && child.signalCode === null) child.kill(signal);
			}
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				timeout = setTimeout(() => this.finishGrace?.(), this.graceMs);
				await Promise.race([Promise.all(this.children.values()), interruptedAgain]);
			} finally { clearTimeout(timeout); this.finishGrace = undefined; }
			try { await this.rememberTree(); } catch (error) { errors.push(error); }
			try { await this.cleanup(); } catch (error) { errors.push(error); }
			if (errors.length) throw new AggregateError(errors, 'Process cancellation failed');
		})();
	}

	public close(): Promise<void> {
		this.stopped = true;
		return this.closing ??= this.cleanup();
	}

	private async resources(): Promise<RunResource[]> {
		if (!this.directory) return [];
		const names = (await readdir(this.directory)).filter(name => name.startsWith('resource-') && name.endsWith('.json'));
		const resources: RunResource[] = [];
		for (const name of names) {
			try { resources.push(JSON.parse(await readFile(join(this.directory, name), 'utf8'))); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
		}
		return resources;
	}

	private async rememberTree(): Promise<Map<number, ProcessIdentity>> {
		const current = await processes(this.windowsProcessTable);
		const roots = new Set<number>();
		for (const child of this.children.keys()) {
			if (child.pid && child.exitCode === null && child.signalCode === null && current.has(child.pid)) roots.add(child.pid);
		}
		for (const resource of await this.resources()) {
			if (!resource.process) continue;
			const active = current.get(resource.process.pid);
			if (active && active.started !== resource.process.started) continue;
			// A worker may die before this supervisor ever observes its registered
			// roots. Retain exited roots as group/ancestry anchors for their helpers.
			this.owned.set(resource.process.pid, resource.process);
			roots.add(resource.process.pid);
		}
		for (const identity of this.owned.values()) {
			if (current.get(identity.pid)?.started === identity.started) roots.add(identity.pid);
		}
		let changed = true;
		while (changed) {
			changed = false;
			const groups = new Set([...this.owned.values()].filter(identity => identity.group === identity.pid && (!current.has(identity.pid) || current.get(identity.pid)?.started === identity.started)).map(identity => identity.pid));
			for (const pid of roots) {
				const identity = current.get(pid);
				if (identity?.group === pid) groups.add(pid);
			}
			for (const identity of current.values()) {
				if (!roots.has(identity.pid) && (roots.has(identity.parent) || (identity.group !== undefined && groups.has(identity.group)))) { roots.add(identity.pid); changed = true; }
			}
		}
		for (const pid of roots) {
			const identity = current.get(pid);
			if (identity) this.owned.set(pid, identity);
		}
		return current;
	}

	private async cleanup(): Promise<void> {
		try { await this.cleanupResources(); }
		finally { await this.windowsProcessTable?.close(); }
	}

	private async cleanupResources(): Promise<void> {
		const errors: unknown[] = [];
		let current: Map<number, ProcessIdentity> | undefined;
		try { current = await this.rememberTree(); } catch (error) { errors.push(error); }
		const resources = await this.resources();
		current ??= await processes(this.windowsProcessTable);
		const terminationErrors = new Map<number, unknown>();
		if (process.platform !== 'win32') {
			// Kill owned groups as well as the snapshot's PIDs: a renderer can fork
			// another helper between enumeration and delivery of the signal.
			for (const root of this.owned.values()) {
				if (root.group !== root.pid) continue;
				const memberAlive = [...this.owned.values()].some(member => member.group === root.pid && current.get(member.pid)?.started === member.started);
				if (!memberAlive) continue;
				try { process.kill(-root.pid, 'SIGKILL'); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') errors.push(error); }
			}
		}
		for (const identity of [...this.owned.values()].reverse()) {
			if (current.get(identity.pid)?.started !== identity.started) continue;
			try {
				if (process.platform === 'win32') await execute('taskkill', ['/PID', String(identity.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 });
				else process.kill(identity.pid, 'SIGKILL');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ESRCH') terminationErrors.set(identity.pid, error);
			}
		}
		if (this.windowsProcessTable && terminationErrors.size > 0) {
			// taskkill can fail during system enumeration. The fallback checks the
			// creation time on the same handle it uses to terminate the process.
			const targets = [...terminationErrors.keys()].map(pid => current.get(pid)!);
			try { await this.windowsProcessTable.terminate(targets); }
			catch (error) { errors.push(error); }
		}
		// Confirm exit rather than equating delivery of a signal with termination.
		const deadline = Date.now() + 5_000;
		while (true) {
			const remaining = await processes(this.windowsProcessTable);
			const alive = [...this.owned.values()].filter(identity => remaining.get(identity.pid)?.started === identity.started);
			if (!alive.length) break;
			if (Date.now() >= deadline) {
				for (const identity of alive) if (terminationErrors.has(identity.pid)) errors.push(terminationErrors.get(identity.pid));
				errors.push(new Error(`Owned processes did not exit: ${alive.map(identity => identity.pid).join(', ')}`));
				break;
			}
			await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 50));
		}
		// End workers and renderers before stopping daemons, so clients cannot
		// reconnect and start a new backend generation during cancellation.
		// The daemon's stop contract validates its persisted process generation and
		// terminates its extension hosts. Never kill a daemon by executable name.
		const stops = await Promise.allSettled(resources.filter(resource => resource.daemon).map(async resource => {
			await execute(resource.daemon!.executable, ['stop'], { env: { ...process.env, ASH_HOME: resource.daemon!.profile }, windowsHide: true, timeout: 30_000 });
		}));
		for (const result of stops) if (result.status === 'rejected') errors.push(result.reason);
		if (errors.length) throw new AggregateError(errors, 'Process resource cleanup failed');
		await Promise.all(this.registrations.map(resource => resource.dispose()));
	}
}

async function processes(windowsProcessTable?: WindowsProcessTable): Promise<Map<number, ProcessIdentity>> {
	if (process.platform === 'win32') {
		const table = windowsProcessTable ?? new WindowsProcessTable();
		let rows: string[];
		try { rows = await table.snapshot(); }
		finally { if (!windowsProcessTable) await table.close(); }
		const entries = new Map<number, ProcessIdentity>();
		for (const line of rows) {
			const match = line.match(/^(\d+)\t(\d+)\t(\d+)$/u);
			if (!match) throw new Error('Invalid Windows process snapshot row');
			const pid = Number(match[1]);
			if (isProcessRunning(pid)) entries.set(pid, { pid, parent: Number(match[2]), started: match[3] });
		}
		return entries;
	}
	const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
	const entries = new Map<number, ProcessIdentity>();
	for (const line of stdout.split('\n')) {
		const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u);
		// Zombies have already exited; their parent owns reaping them.
		if (match && !match[4].startsWith('Z')) entries.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), started: match[5].trim() });
	}
	return entries;
}

const commandTimeout = 45_000;

interface WindowsProcessSession {
	readonly child: ChildProcessWithoutNullStreams;
	readonly lines: AsyncIterator<string>;
	readonly exit: Promise<string>;
}

/** Reuses one native process table helper until the owning process run closes. */
class WindowsProcessTable {
	private session: WindowsProcessSession | undefined;
	private pending: Promise<void> = Promise.resolve();

	snapshot(): Promise<string[]> {
		return this.execute('snapshot');
	}

	async terminate(targets: readonly { pid: number; started: string; }[]): Promise<void> {
		await this.execute(targets.map(({ pid, started }) => `${pid}\t${started}`).join(';'));
	}

	async close(): Promise<void> {
		await this.pending;
		if (!this.session) return;
		const { child, exit } = this.session;
		const timeout = setTimeout(() => child.kill(), commandTimeout);
		try {
			child.stdin.end();
			await exit;
		} finally {
			clearTimeout(timeout);
		}
	}

	private execute(command: string): Promise<string[]> {
		// All requests use one ordered stream, including concurrent unit workers.
		const result = this.pending.then(() => this.request(command));
		this.pending = result.then(() => undefined, () => undefined);
		return result;
	}

	private async request(command: string): Promise<string[]> {
		const { child, lines, exit } = this.session ??= startWindowsProcessSession();
		const timeout = setTimeout(() => child.kill(), commandTimeout);
		try {
			child.stdin.write(command + '\n');
			const rows: string[] = [];
			for (let line = await lines.next(); !line.done; line = await lines.next()) {
				if (line.value === '.') return rows;
				rows.push(line.value);
			}
			throw new Error(`Windows process helper closed before completing its request (${await exit})`);
		} catch (error) {
			// Cleanup may need another snapshot after a failed command.
			this.session = undefined;
			child.kill();
			await exit;
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}
}

function startWindowsProcessSession(): WindowsProcessSession {
	// Windows PowerShell needs its own module path when invoked from PowerShell 7.
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
	const command = Buffer.from(windowsProcessInterop, 'utf16le').toString('base64');
	const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], { env, windowsHide: true });
	let diagnostics = '';
	child.stdin.on('error', () => { /* The process exit reports a broken pipe. */ });
	child.on('error', error => { diagnostics += error.message; });
	child.stderr.setEncoding('utf8').on('data', (chunk: string) => { diagnostics = (diagnostics + chunk).slice(-8192); });
	const exit = new Promise<string>(resolve => {
		child.once('close', (code, signal) => resolve(diagnostics.trim() || signal || `exit ${code}`));
	});
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
	return { child, lines, exit };
}

// Tool Help reports the original parent PID even after that parent exits. Read
// creation times from process handles so this path works when WMI is unavailable.
const windowsProcessInterop = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AshProcessTable
{
    private const uint SnapshotProcesses = 0x00000002;
    private const uint QueryLimitedInformation = 0x00001000;
    private const uint TerminateAccess = 0x00000001;
    private const int NoMoreFiles = 18;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size;
        public uint Usage;
        public uint Pid;
        public UIntPtr DefaultHeap;
        public uint Module;
        public uint Threads;
        public uint Parent;
        public int BasePriority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string Executable;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll")]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint pid);

    [DllImport("kernel32.dll")]
    private static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    public static void Run()
    {
        string command;
        while ((command = Console.ReadLine()) != null)
        {
            if (command == "snapshot")
                Write();
            else
                foreach (string target in command.Split(';'))
                {
                    string[] fields = target.Split('\t');
                    Terminate(uint.Parse(fields[0]), long.Parse(fields[1]));
                }
            Console.WriteLine(".");
        }
    }

    private static void Write()
    {
        long snapshotStarted = DateTime.UtcNow.ToFileTimeUtc();
        IntPtr snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
        if (snapshot == new IntPtr(-1))
            throw new Win32Exception(Marshal.GetLastWin32Error());

        try
        {
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (!Process32First(snapshot, ref entry))
                throw new Win32Exception(Marshal.GetLastWin32Error());

            do { WriteEntry(entry, snapshotStarted); }
            while (Process32Next(snapshot, ref entry));

            int error = Marshal.GetLastWin32Error();
            if (error != NoMoreFiles)
                throw new Win32Exception(error);
        }
        finally { CloseHandle(snapshot); }
    }

    private static void WriteEntry(ProcessEntry entry, long snapshotStarted)
    {
        IntPtr process = OpenProcess(QueryLimitedInformation, false, entry.Pid);
        if (process == IntPtr.Zero)
            return;

        try
        {
            long created = CreationTime(process);
            // A PID can be reused between the snapshot and opening its handle.
            if (created > 0 && created <= snapshotStarted)
                Console.WriteLine("{0}\t{1}\t{2}", entry.Pid, entry.Parent, DateTime.FromFileTimeUtc(created).Ticks);
        }
        finally { CloseHandle(process); }
    }

    private static void Terminate(uint pid, long started)
    {
        IntPtr process = OpenProcess(QueryLimitedInformation | TerminateAccess, false, pid);
        if (process == IntPtr.Zero)
            return;

        try
        {
            long created = CreationTime(process);
            if (created > 0 && DateTime.FromFileTimeUtc(created).Ticks == started)
                TerminateProcess(process, 1);
        }
        finally { CloseHandle(process); }
    }

    private static long CreationTime(IntPtr process)
    {
        long created, exited, kernel, user;
        return GetProcessTimes(process, out created, out exited, out kernel, out user) ? created : 0;
    }
}
'@
[AshProcessTable]::Run()
`;

/**
 * Installs cancellation before any work starts and owns the cross-process registry.
 * Pass the supplied environment to children; callbacks creating temporary files
 * or registering resources in this process must use its directories explicitly.
 */
export async function withProcessRun(cwd: string, action: (run: ProcessRun, environment: NodeJS.ProcessEnv) => Promise<void>, options: { graceMs?: number; } = {}): Promise<void> {
	const inherited = process.env.ASH_SMOKE_RUN_DIRECTORY;
	// Keep the path short enough for Chromium's temporary Unix sockets.
	const directory = inherited ?? await mkdtemp(join(tmpdir(), 'ash-run-'));
	const temporaryDirectory = join(directory, 'tmp');
	const run = new ProcessRun(cwd, directory, options.graceMs);
	let interruption: number | undefined;
	const interrupt = (signal: NodeJS.Signals): void => {
		interruption ??= signal === 'SIGINT' ? 130 : 143;
		void run.stop(signal).catch(() => { /* close reports cancellation errors. */ });
	};
	const onInterrupt = (): void => interrupt('SIGINT');
	const onTerminate = (): void => interrupt('SIGTERM');
	process.on('SIGINT', onInterrupt);
	process.on('SIGTERM', onTerminate);
	let actionFailed = false;
	let actionFailure: unknown;
	try {
		await mkdir(temporaryDirectory, { recursive: true });
		// Killed workers and native helpers cannot run their own temporary-file
		// destructors. Their supervisor removes this tree after all processes exit.
		await action(run, {
			...process.env,
			ASH_SMOKE_RUN_DIRECTORY: directory,
			TMPDIR: temporaryDirectory,
			TMP: temporaryDirectory,
			TEMP: temporaryDirectory,
		});
	} catch (error) {
		// Worker cleanup also stops the run; only an observed signal makes
		// a subsequent operation failure part of cancellation.
		if (interruption === undefined) {
			actionFailed = true;
			actionFailure = error;
			throw error;
		}
	} finally {
		try {
			try { await run.close(); if (interruption) process.exitCode = interruption; }
			catch (error) {
				if (actionFailed) throw new AggregateError([actionFailure, error], 'Process action and cleanup failed');
				throw error;
			}
		}
		finally {
			process.off('SIGINT', onInterrupt);
			process.off('SIGTERM', onTerminate);
			if (!inherited) await rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
		}
	}
}
