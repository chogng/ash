import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unwatchFile, watchFile } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Disposable, DisposableMap, DisposableStore, type IDisposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { AppServerConnectionRelay } from '../../agentHost/electron-main/appServerConnectionRelay.js';
import type { AppServerDaemonLauncher } from './appServerDaemonLauncher.js';
import type { IDevelopmentAppServerRuntime } from './developmentAppServerRuntime.js';
import { ILogService } from '../../log/common/log.js';
import { readDevelopmentAppServerGeneration } from '../node/developmentAppServerGeneration.js';

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
}

/** One profile-wide restart owner; windows register connections for their own lifetimes. */
export class DevelopmentAppServerReloader extends Disposable {
	private readonly registrations = this._register(new DisposableMap<DevelopmentConnection, DisposableStore>());
	private readonly connections = new Set<Connection>();
	private readonly readGeneration: (generationFile: string) => Promise<string | undefined>;
	private timeout?: NodeJS.Timeout;
	private readonly pendingRuntime = this._register(new MutableDisposable<IDevelopmentAppServerRuntime>());
	private readonly restartingRuntime = this._register(new MutableDisposable<IDevelopmentAppServerRuntime>());
	private readonly selectedRuntime = this._register(new MutableDisposable<IDevelopmentAppServerRuntime>());
	private selectionPromise?: Promise<void>;
	private drainPromise?: Promise<void>;
	private restartBarrier?: Promise<void>;
	private reloadRevision = 0;

	constructor(private readonly options: DevelopmentAppServerReloaderOptions, @ILogService private readonly log: ILogService) {
		super();
		this.readGeneration = options.readGeneration ?? readDevelopmentAppServerGeneration;
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
			if (this.pendingRuntime.value && this.canRestart()) void this.ensureDrain().catch(() => { /* The reload owner records the failed phase. */ });
		}));
		return toDisposable(() => {
			// Workspace switches reuse the relay; an older scope must not unregister its replacement.
			if (this.registrations.get(supervisor) !== resources) return;
			this.registrations.deleteAndDispose(supervisor);
			if (this.pendingRuntime.value && this.canRestart()) void this.ensureDrain().catch(() => { /* The reload owner records the failed phase. */ });
		});
	}

	async reloadNow(): Promise<void> {
		if (this.isDisposed) return;
		const revision = ++this.reloadRevision;
		await this.selectionPromise;
		const runtime = await this.readGeneration(this.options.generationFile).catch(error => { this.log.error('app-server.reload', 'Development publication read failed', error); throw error; });
		if (this.isDisposed || revision !== this.reloadRevision || !runtime) return;
		if (runtime === this.selectedRuntime.value?.runtime && !this.pendingRuntime.value) return;
		const carrier = [...this.connections][0];
		if (!carrier) return;
		const lease = await (this.options.acquireGeneration?.(carrier.launcher) ?? carrier.launcher.acquireDevelopmentRuntime()).catch(error => { this.log.error('app-server.reload', 'Development runtime acquisition failed', { runtime: basename(runtime) }, error); throw error; });
		// Pointer reads and lease acquisition can finish out of order while another
		// build is published. Only the newest reload may choose a pending runtime.
		if (this.isDisposed || revision !== this.reloadRevision || lease.runtime === this.selectedRuntime.value?.runtime) { lease.dispose(); return; }
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
			void this.reloadNow().catch(() => { /* The reload owner records the failed phase. */ });
		}, this.options.debounceMs ?? 200);
	}

	private canRestart(): boolean {
		return [...this.connections].every(({ supervisor }) => ['ready', 'crashed', 'stopped'].includes(supervisor.state));
	}

	private async readPublication(runtime: string): Promise<object> {
		try {
			const text = await readFile(resolve(dirname(this.options.generationFile), 'publication.json'), 'utf8');
			if (Buffer.byteLength(text, 'utf8') > 262_144) { throw new Error('Development publication metadata is oversized'); }
			const value: unknown = JSON.parse(text);
			if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Invalid development publication metadata'); }
			const record = value as Record<string, unknown>;
			const validRuntime = (value: unknown): boolean => typeof value === 'string' && /^generations\/[a-f0-9]{64}$/u.test(value);
			const files = record.files;
			if (record.version !== 1 || !validRuntime(record.runtime) || record.previousRuntime !== null && !validRuntime(record.previousRuntime)
				|| typeof record.buildId !== 'string' || !/^[a-f0-9-]{36}$/u.test(record.buildId)
				|| !['source-change', 'initial-build', 'manual-build', 'prepared-runtime-selection'].includes(String(record.reason))
				|| !Number.isSafeInteger(record.timestampMillis) || (record.timestampMillis as number) < 0
				|| !Number.isSafeInteger(record.omittedFileCount) || (record.omittedFileCount as number) < 0
				|| !Array.isArray(files) || files.length > 128 || files.some(file => typeof file !== 'string' || !file || file.length > 1024 || /[\\:\0]/u.test(file) || file.split('/').some(part => !part || part === '.' || part === '..'))
				|| record.buildLog !== undefined && (typeof record.buildLog !== 'string' || record.buildLog.length > 4096 || !isAbsolute(record.buildLog))) {
				throw new Error('Invalid development publication metadata');
			}
			// A later publisher can replace diagnostics after our lease was acquired.
			// Never attribute its trigger to this runtime; leases remain authoritative.
			if (record.runtime !== `generations/${basename(runtime)}`) { return { reason: 'runtime-publication', publicationMetadata: 'superseded' }; }
			return { reason: record.reason, buildId: record.buildId, files, omittedFileCount: record.omittedFileCount, publishedAtMillis: record.timestampMillis, buildLog: record.buildLog };
		} catch (error) {
			if (isNodeError(error) && error.code === 'ENOENT') { return { reason: 'runtime-publication', publicationMetadata: 'missing' }; }
			this.log.warn('app-server.reload', 'Development publication metadata unavailable', error);
			return { reason: 'runtime-publication', publicationMetadata: 'invalid' };
		}
	}

	private async drain(): Promise<void> {
		while (!this.isDisposed && this.pendingRuntime.value && this.canRestart()) {
			const lease = this.pendingRuntime.clearAndLeak()!;
			this.restartingRuntime.value = lease;
			const runtime = lease.runtime;
			const connections = [...this.connections];
			const changed = connections.some(({ launcher }) => launcher.environment.ASH_DEV_RUNTIME_ROOT !== runtime);
			if (!changed) {
				try {
					for (const { launcher } of connections) launcher.selectDevelopmentRuntime(lease);
					this.selectedRuntime.value = this.restartingRuntime.clearAndLeak();
				} catch (error) {
					this.log.error('app-server.reload', 'Development runtime selection failed', { runtime: basename(runtime) }, error);
					throw error;
				}
				continue;
			}
			const running = connections.filter(({ supervisor }) => supervisor.state !== 'stopped');
			let detail = {
				restartId: randomUUID(),
				previousRuntimes: [...new Set(connections.map(({ launcher }) => launcher.environment.ASH_DEV_RUNTIME_ROOT).filter((value): value is string => value !== undefined).map(value => basename(value)))].sort(),
				runtime: basename(runtime), connectionCount: running.length,
			};
			const started = performance.now();
			let phase = 'stopping-connections';
			// New windows wait until the profile daemon has adopted this generation. Release the
			// barrier before reconnecting existing windows, whose launcher validation also awaits it.
			let release!: () => void;
			this.restartBarrier = new Promise<void>(resolvePromise => { release = resolvePromise; });
			try {
				detail = { ...detail, ...await this.readPublication(runtime) };
				if (this.isDisposed) { return; }
				this.log.info('app-server.reload', 'Development runtime restart started', detail);
				await Promise.all(running.map(({ supervisor }) => supervisor.stop()));
				if (this.isDisposed) return;
				for (const { launcher } of this.connections) launcher.selectDevelopmentRuntime(lease);
				this.selectedRuntime.value = this.restartingRuntime.clearAndLeak();
				const carrier = [...this.connections][0];
				phase = 'restarting-daemon';
				if (running.length > 0 && carrier) await (this.options.restartDaemon ?? restartManagedDaemon)(carrier.launcher);
			} catch (error) {
				this.log.error('app-server.reload', 'Development runtime restart failed', { ...detail, phase, durationMillis: Math.round(performance.now() - started) }, error);
				throw error;
			} finally {
				this.restartingRuntime.clear();
				this.restartBarrier = undefined;
				release();
			}
			if (this.isDisposed) return;
			try {
				await Promise.all(running.filter(connection => this.connections.has(connection)).map(({ supervisor }) => supervisor.start()));
				this.log.info('app-server.reload', 'Development runtime restart completed', { ...detail, durationMillis: Math.round(performance.now() - started) });
			} catch (error) {
				this.log.error('app-server.reload', 'Development runtime restart failed', { ...detail, phase: 'reconnecting', durationMillis: Math.round(performance.now() - started) }, error);
				throw error;
			}
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
			void this.ensureDrain().catch(() => { /* The reload owner records the failed phase. */ });
		}
	}
}

async function restartManagedDaemon(launcher: AppServerDaemonLauncher): Promise<void> {
	await execFileAsync(launcher.executable, ['restart'], { env: { ...launcher.environment }, maxBuffer: 1_048_576, timeout: 40_000, windowsHide: true });
}

function watchGenerationFile(generationFile: string, listener: () => void): IDisposable {
	// Publication atomically replaces this small pointer. Native directory watches
	// can silently miss it, leaving every window on the old runtime indefinitely.
	// Stat polling avoids that dependency; reloadNow still validates and leases the generation.
	watchFile(generationFile, { persistent: false, interval: 250 }, listener);
	return toDisposable(() => unwatchFile(generationFile, listener));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
