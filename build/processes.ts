import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Checks OS liveness; an exited Windows process can retain a CIM entry while handles remain open. */
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

/** Registers resources that can outlive a Playwright worker, before they start. */
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
	public stopped = false;

	private readonly cwd: string;
	private readonly directory: string | undefined;
	private readonly graceMs: number;
	constructor(cwd: string, directory?: string, graceMs = 45_000) { this.cwd = cwd; this.directory = directory; this.graceMs = graceMs; }

	public async command(command: string, args: readonly string[], env: NodeJS.ProcessEnv, capture = false): Promise<{ code: number; output: string; }> {
		if (this.stopped) throw new Error('Process run was stopped; refusing to start another command.');
		const child = spawn(command, args, { cwd: this.cwd, env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', detached: process.platform !== 'win32', windowsHide: true });
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
		return await result;
	}

	public async own(child: ChildProcess): Promise<void> {
		if (this.stopped) throw new Error('Process run was stopped; refusing to own another process.');
		let spawnError: Error | undefined;
		child.once('error', error => { spawnError = error; });
		this.children.set(child, child.exitCode !== null || child.signalCode !== null || !child.pid
			? Promise.resolve() : new Promise<void>(resolveExit => { child.once('exit', () => resolveExit()); child.once('error', () => resolveExit()); }));
		await this.rememberTree();
		if (spawnError) throw spawnError;
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
		const current = await processes();
		const roots = new Set<number>();
		for (const child of this.children.keys()) {
			if (child.pid && child.exitCode === null && child.signalCode === null && current.has(child.pid)) roots.add(child.pid);
		}
		for (const resource of await this.resources()) {
			if (resource.process && current.get(resource.process.pid)?.started === resource.process.started) roots.add(resource.process.pid);
		}
		for (const identity of this.owned.values()) {
			if (current.get(identity.pid)?.started === identity.started) roots.add(identity.pid);
		}
		let changed = true;
		while (changed) {
			changed = false;
			const groups = new Set([...this.owned.values(), ...[...roots].map(pid => current.get(pid)!)].filter(identity => identity.group === identity.pid).map(identity => identity.pid));
			for (const identity of current.values()) {
				if (!roots.has(identity.pid) && (roots.has(identity.parent) || (identity.group !== undefined && groups.has(identity.group)))) { roots.add(identity.pid); changed = true; }
			}
		}
		for (const pid of roots) this.owned.set(pid, current.get(pid)!);
		return current;
	}

	private async cleanup(): Promise<void> {
		const errors: unknown[] = [];
		let current: Map<number, ProcessIdentity> | undefined;
		try { current = await this.rememberTree(); } catch (error) { errors.push(error); }
		const resources = await this.resources();
		current ??= await processes();
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
		// Confirm exit rather than equating delivery of a signal with termination.
		const deadline = Date.now() + 5_000;
		while (true) {
			const remaining = await processes();
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
	}
}

async function processes(): Promise<Map<number, ProcessIdentity>> {
	if (process.platform === 'win32') {
		// A PowerShell 7 runner's module path is incompatible with the built-in
		// Windows PowerShell used here. Let that host discover its own CIM modules.
		const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
		const query = execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | Where-Object { $_.CreationDate } | Select-Object ProcessId,ParentProcessId,@{n="Started";e={$_.CreationDate.ToUniversalTime().Ticks.ToString()}} | ConvertTo-Json -Compress'], { env: environment, windowsHide: true, timeout: 45_000, maxBuffer: 8 * 1024 * 1024 });
		query.child.stdin?.end();
		const { stdout } = await query;
		const entries = JSON.parse(stdout) as { ProcessId: number; ParentProcessId: number; Started: string; }[];
		return new Map(entries.filter(entry => isProcessRunning(entry.ProcessId)).map(entry => [entry.ProcessId, { pid: entry.ProcessId, parent: entry.ParentProcessId, started: entry.Started }]));
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

/** Installs cancellation before any work starts and owns the cross-process registry. */
export async function withProcessRun(cwd: string, action: (run: ProcessRun, environment: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
	const inherited = process.env.ASH_SMOKE_RUN_DIRECTORY;
	const directory = inherited ?? await mkdtemp(join(tmpdir(), 'ash-process-run-'));
	const run = new ProcessRun(cwd, directory);
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
		await action(run, { ...process.env, ASH_SMOKE_RUN_DIRECTORY: directory });
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
			if (!inherited) await rm(directory, { force: true, recursive: true });
		}
	}
}
