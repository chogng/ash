import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Disposable, DisposableMap, DisposableStore, type IDisposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { AppServerConnectionRelay } from '../../app-server/electron-main/appServerConnectionRelay.js';
import type { AppServerDaemonLauncher } from './appServerDaemonLauncher.js';
import type { IDevelopmentAppServerRuntime } from './developmentAppServerRuntime.js';

const execFileAsync = promisify(execFile);
type DevelopmentConnection = Pick<AppServerConnectionRelay, 'onStateChange' | 'start' | 'state' | 'stop'>;
interface Connection {
	readonly launcher: AppServerDaemonLauncher;
	readonly supervisor: DevelopmentConnection;
}
interface DevelopmentAppServerReloaderOptions {
	readonly generationFile: string;
	readonly debounceMs?: number;
	readonly watchGeneration?: (generationFile: string, listener: () => void) => IDisposable;
	readonly readGeneration?: (generationFile: string) => Promise<string | undefined>;
	readonly acquireGeneration?: (launcher: AppServerDaemonLauncher) => Promise<IDevelopmentAppServerRuntime>;
	readonly restartDaemon?: (launcher: AppServerDaemonLauncher) => Promise<void>;
	readonly log?: (message: string, error?: unknown) => void;
}

/** One profile-wide restart owner; windows register connections for their own lifetimes. */
export class DevelopmentAppServerReloader extends Disposable {
	private readonly registrations = this._register(new DisposableMap<DevelopmentConnection, DisposableStore>());
	private readonly connections = new Set<Connection>();
	private readonly readGeneration: (generationFile: string) => Promise<string | undefined>;
	private readonly log: (message: string, error?: unknown) => void;
	private timeout?: NodeJS.Timeout;
	private readonly pendingRuntime = this._register(new MutableDisposable<IDevelopmentAppServerRuntime>());
	private readonly restartingRuntime = this._register(new MutableDisposable<IDevelopmentAppServerRuntime>());
	private readonly selectedRuntime = this._register(new MutableDisposable<IDevelopmentAppServerRuntime>());
	private selectionPromise?: Promise<void>;
	private drainPromise?: Promise<void>;
	private restartBarrier?: Promise<void>;

	constructor(private readonly options: DevelopmentAppServerReloaderOptions) {
		super();
		this.readGeneration = options.readGeneration ?? readDevelopmentAppServerGeneration;
		this.log = options.log ?? ((message, error) => error === undefined ? console.info(message) : console.error(message, error));
		this._register((options.watchGeneration ?? watchGenerationFile)(options.generationFile, () => this.schedule()));
		this._register(toDisposable(() => { if (this.timeout) clearTimeout(this.timeout); }));
	}

	registerConnection(launcher: AppServerDaemonLauncher, supervisor: DevelopmentConnection): IDisposable {
		this.assertNotDisposed();
		const connection = { launcher, supervisor };
		const resources = new DisposableStore();
		this.registrations.set(supervisor, resources);
		this.connections.add(connection);
		resources.add(toDisposable(() => { this.connections.delete(connection); }));
		resources.add(launcher.setDevelopmentStartupBarrier(async () => {
			await this.restartBarrier;
			await this.ensureSelectedRuntime(launcher);
			launcher.selectDevelopmentRuntime(this.selectedRuntime.value!);
		}));
		resources.add(supervisor.onStateChange(() => {
			if (this.pendingRuntime.value && this.canRestart()) void this.ensureDrain().catch(error => this.log('[app-server] Development restart failed', error));
		}));
		return toDisposable(() => {
			// Workspace switches reuse the relay; an older scope must not unregister its replacement.
			if (this.registrations.get(supervisor) !== resources) return;
			this.registrations.deleteAndDispose(supervisor);
			if (this.pendingRuntime.value && this.canRestart()) void this.ensureDrain().catch(error => this.log('[app-server] Development restart failed', error));
		});
	}

	async reloadNow(): Promise<void> {
		if (this.isDisposed) return;
		await this.selectionPromise;
		const runtime = await this.readGeneration(this.options.generationFile);
		if (this.isDisposed || !runtime) return;
		if (runtime === this.selectedRuntime.value?.runtime && !this.pendingRuntime.value) return;
		const carrier = [...this.connections][0];
		if (!carrier) return;
		const lease = await (this.options.acquireGeneration?.(carrier.launcher) ?? carrier.launcher.acquireDevelopmentRuntime());
		if (this.isDisposed || lease.runtime === this.selectedRuntime.value?.runtime) { lease.dispose(); return; }
		this.pendingRuntime.value = lease;
		await this.ensureDrain();
	}

	private async ensureSelectedRuntime(launcher: AppServerDaemonLauncher): Promise<void> {
		if (this.selectedRuntime.value) return;
		if (!this.selectionPromise) {
			this.selectionPromise = (async () => {
				const lease = await (this.options.acquireGeneration?.(launcher) ?? launcher.acquireDevelopmentRuntime());
				if (this.isDisposed) { lease.dispose(); this.assertNotDisposed(); }
				this.selectedRuntime.value = lease;
			})();
		}
		try { await this.selectionPromise; } finally { this.selectionPromise = undefined; }
		this.assertNotDisposed();
	}

	private schedule(): void {
		if (this.timeout) clearTimeout(this.timeout);
		this.timeout = setTimeout(() => {
			this.timeout = undefined;
			void this.reloadNow().catch(error => this.log('[app-server] Development restart failed', error));
		}, this.options.debounceMs ?? 200);
	}

	private canRestart(): boolean {
		return [...this.connections].every(({ supervisor }) => ['ready', 'crashed', 'stopped'].includes(supervisor.state));
	}

	private async drain(): Promise<void> {
		while (!this.isDisposed && this.pendingRuntime.value && this.canRestart()) {
			const lease = this.pendingRuntime.clearAndLeak()!;
			this.restartingRuntime.value = lease;
			const runtime = lease.runtime;
			const connections = [...this.connections];
			const changed = connections.some(({ launcher }) => launcher.environment.ASH_DEV_RUNTIME_ROOT !== runtime);
			if (!changed) {
				for (const { launcher } of connections) launcher.selectDevelopmentRuntime(lease);
				this.selectedRuntime.value = this.restartingRuntime.clearAndLeak();
				continue;
			}
			const running = connections.filter(({ supervisor }) => supervisor.state !== 'stopped');
			// New windows wait until the profile daemon has adopted this generation. Release the
			// barrier before reconnecting existing windows, whose launcher validation also awaits it.
			let release!: () => void;
			this.restartBarrier = new Promise<void>(resolvePromise => { release = resolvePromise; });
			try {
				await Promise.all(running.map(({ supervisor }) => supervisor.stop()));
				if (this.isDisposed) return;
				for (const { launcher } of this.connections) launcher.selectDevelopmentRuntime(lease);
				this.selectedRuntime.value = this.restartingRuntime.clearAndLeak();
				const carrier = [...this.connections][0];
				if (running.length > 0 && carrier) await (this.options.restartDaemon ?? restartManagedDaemon)(carrier.launcher);
			} finally {
				this.restartingRuntime.clear();
				this.restartBarrier = undefined;
				release();
			}
			if (this.isDisposed) return;
			await Promise.all(running.filter(connection => this.connections.has(connection)).map(({ supervisor }) => supervisor.start()));
			this.log(`[app-server] Restarted development runtime ${basename(runtime)}`);
		}
	}

	private ensureDrain(): Promise<void> {
		if (this.drainPromise) return this.drainPromise;
		// Defer work until the promise is installed, so synchronous state events cannot
		// re-enter the drain while the first connection is stopping.
		const drain = Promise.resolve().then(() => this.drain());
		this.drainPromise = drain;
		void drain.then(() => this.completeDrain(drain), () => this.completeDrain(drain));
		return drain;
	}

	private completeDrain(drain: Promise<void>): void {
		if (this.drainPromise !== drain) return;
		this.drainPromise = undefined;
		if (this.pendingRuntime.value && this.canRestart() && !this.isDisposed) {
			void this.ensureDrain().catch(error => this.log('[app-server] Development restart failed', error));
		}
	}
}

export async function readDevelopmentAppServerGeneration(generationFile: string): Promise<string | undefined> {
	try {
		return parseDevelopmentAppServerGeneration(generationFile, await readFile(generationFile, 'utf8'));
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT' && error.path === generationFile) return undefined;
		throw error;
	}
}

export function readDevelopmentAppServerGenerationSync(generationFile: string): string | undefined {
	try {
		return parseDevelopmentAppServerGeneration(generationFile, readFileSync(generationFile, 'utf8'));
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT' && error.path === generationFile) return undefined;
		throw error;
	}
}

function parseDevelopmentAppServerGeneration(generationFile: string, contents: string): string {
	if (Buffer.byteLength(contents, 'utf8') > 4_096) throw new Error('Development runtime generation is oversized');
	const value: unknown = JSON.parse(contents);
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Development runtime generation is invalid');
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join(',') !== 'runtime,version' || record.version !== 3 || typeof record.runtime !== 'string' || !/^generations\/[a-f0-9]{64}$/u.test(record.runtime)) throw new Error('Development runtime generation is invalid');
	const runtime = resolve(dirname(generationFile), record.runtime);
	// This read is only a change notification. Rust validates the files while
	// holding publish.lock and returns a lease before they can be used.
	return runtime;
}

async function restartManagedDaemon(launcher: AppServerDaemonLauncher): Promise<void> {
	await execFileAsync(launcher.executable, ['restart'], { env: { ...launcher.environment }, maxBuffer: 1_048_576, timeout: 40_000, windowsHide: true });
}

function watchGenerationFile(generationFile: string, listener: () => void): IDisposable {
	const directory = dirname(generationFile);
	const file = basename(generationFile);
	mkdirSync(directory, { recursive: true });
	const watcher = watch(directory, (_event, changed) => {
		if (changed === null || changed.toString() === file) listener();
	});
	return toDisposable(() => watcher.close());
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
