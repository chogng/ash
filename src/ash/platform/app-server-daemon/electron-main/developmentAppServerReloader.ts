import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unwatchFile, watchFile } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Disposable, DisposableMap, DisposableStore, type IDisposable, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { AppServerConnectionRelay } from '../../agentHost/electron-main/appServerConnectionRelay.js';
import type { AppServerDaemonLauncher } from './appServerDaemonLauncher.js';
import type { IDevelopmentAppServerRuntime } from './developmentAppServerRuntime.js';
import { ILogService } from '../../log/common/log.js';
import { readDevelopmentAppServerGeneration } from '../node/developmentAppServerGeneration.js';

const execFileAsync = promisify(execFile);
interface SuccessfulPreflight { readonly cleanup: Promise<void>; }

type DevelopmentConnection = Pick<AppServerConnectionRelay, 'onStateChange' | 'start' | 'state' | 'stop'>;
interface Connection {
	readonly launcher: AppServerDaemonLauncher;
	readonly supervisor: DevelopmentConnection;
}
interface DevelopmentAppServerReloaderOptions {
	readonly generationFile: string;
	readonly watchGeneration?: (generationFile: string, listener: () => void) => IDisposable;
	readonly readGeneration?: (generationFile: string) => Promise<string | undefined>;
	readonly acquireGeneration?: (launcher: AppServerDaemonLauncher) => Promise<IDevelopmentAppServerRuntime>;
	readonly preflight?: (launcher: AppServerDaemonLauncher, lease: IDevelopmentAppServerRuntime) => Promise<SuccessfulPreflight | void>;
	readonly restartDaemon?: (launcher: AppServerDaemonLauncher) => Promise<void>;
}

/** One profile-wide restart owner; windows register connections for their own lifetimes. */
export class DevelopmentAppServerReloader extends Disposable {
	private readonly registrations = this._register(new DisposableMap<DevelopmentConnection, DisposableStore>());
	private readonly connections = new Set<Connection>();
	private readonly reconnecting = new Set<Connection>();
	private readonly readGeneration: (generationFile: string) => Promise<string | undefined>;
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
		this._register((options.watchGeneration ?? watchGenerationFile)(options.generationFile, () => {
			void this.reloadNow().catch(() => { /* The reload owner records the failed phase. */ });
		}));
	}

	registerConnection(launcher: AppServerDaemonLauncher, supervisor: DevelopmentConnection): IDisposable {
		this.assertNotDisposed();
		const connection = { launcher, supervisor };
		const resources = new DisposableStore();
		this.registrations.set(supervisor, resources);
		const refreshOnFirstConnection = !this.connections.size && this.selectedRuntime.value !== undefined;
		this.connections.add(connection);
		// A pointer change can arrive while the Home window has no registered carrier.
		// Reconcile it before the next window can reuse the old profile daemon.
		const refresh = refreshOnFirstConnection ? this.reloadNow().catch(() => { /* The selected lease remains available after a failed preflight. */ }) : undefined;
		resources.add(toDisposable(() => {
			this.connections.delete(connection);
			this.reconnecting.delete(connection);
		}));
		resources.add(launcher.setDevelopmentStartupBarrier(async () => {
			await refresh;
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
		const target = () => this.restartingRuntime.value?.runtime ?? this.selectedRuntime.value?.runtime;
		if (runtime === target() && !this.pendingRuntime.value) return;
		const carrier = [...this.connections][0];
		if (!carrier) return;
		const lease = await (this.options.acquireGeneration?.(carrier.launcher) ?? carrier.launcher.acquireDevelopmentRuntime()).catch(error => { this.log.error('app-server.reload', 'Development runtime acquisition failed', { runtime: basename(runtime) }, error); throw error; });
		// Pointer reads and lease acquisition can finish out of order while another
		// build is published. Only the newest reload may choose a pending runtime.
		if (this.isDisposed || revision !== this.reloadRevision) { lease.dispose(); return; }
		if (lease.runtime === target()) {
			// The pointer can return to the active runtime while an intermediate
			// publication waits for a window to finish initializing.
			this.pendingRuntime.clear();
			lease.dispose();
			return;
		}
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
			const runningConnections = () => [...this.connections].filter(connection => connection.supervisor.state !== 'stopped' || this.reconnecting.has(connection));
			let detail = {
				restartId: randomUUID(),
				previousRuntimes: [...new Set(connections.map(({ launcher }) => launcher.environment.ASH_DEV_RUNTIME_ROOT).filter((value): value is string => value !== undefined).map(value => basename(value)))].sort(),
				runtime: basename(runtime), connectionCount: runningConnections().length,
				preflightDurationMillis: 0,
			};
			const started = performance.now();
			const carrier = connections[0];
			if (!carrier) {
				this.restartingRuntime.clear();
				continue;
			}
			let preflightReady = false;
			let preflightCleanup: Promise<void> | undefined;
			try {
				detail = { ...detail, ...await this.readPublication(runtime) };
				if (this.isDisposed) return;
				const preflightStarted = performance.now();
				const preflight = await (this.options.preflight ?? preflightManagedDaemon)(carrier.launcher, lease);
				preflightCleanup = preflight?.cleanup.catch(error => {
					this.log.error('app-server.reload', 'Development preflight cleanup failed', detail, error);
				});
				detail.preflightDurationMillis = Math.round(performance.now() - preflightStarted);
				if (this.isDisposed) return;
				// A newer publication can arrive before its watch callback.
				if (await this.readGeneration(this.options.generationFile) !== runtime || this.isDisposed) continue;
				if (!this.canRestart()) {
					if (!this.pendingRuntime.value) this.pendingRuntime.value = this.restartingRuntime.clearAndLeak();
					return;
				}
				preflightReady = true;
			} catch (error) {
				this.log.error('app-server.reload', 'Development runtime preflight failed; keeping the current backend', { ...detail, phase: 'preflight' }, error);
				throw error;
			} finally {
				// The commit below still needs the lease after successful preflight.
				if (!preflightReady) {
					await preflightCleanup;
					this.restartingRuntime.clear();
				}
			}
			const running = runningConnections();
			const previous = this.selectedRuntime.value;
			const restartDaemon = this.options.restartDaemon ?? restartManagedDaemon;
			let phase = 'stopping-connections';
			let failure: { readonly error: unknown; } | undefined;
			// New windows wait until the profile daemon has adopted this generation. Release the
			// barrier before reconnecting existing windows, whose launcher validation also awaits it.
			let release!: () => void;
			this.restartBarrier = new Promise<void>(resolvePromise => { release = resolvePromise; });
			try {
				this.log.info('app-server.reload', 'Development runtime restart started', detail);
				for (const connection of running) this.reconnecting.add(connection);
				const stopped = await Promise.allSettled(running.map(({ supervisor }) => supervisor.stop({ drainForRestart: true })));
				if (this.isDisposed) return;
				for (const result of stopped) if (result.status === 'rejected') throw result.reason;
				const carrier = [...this.connections][0];
				phase = 'restarting-daemon';
				// A stopped window can still share a live profile daemon. Update it
				// before the next carrier attaches, including Subsecond's reuse path.
				if (carrier) {
					carrier.launcher.selectDevelopmentRuntime(lease);
					await restartDaemon(carrier.launcher);
				}
				if (this.isDisposed) return;
				for (const { launcher } of this.connections) launcher.selectDevelopmentRuntime(lease);
				this.selectedRuntime.value = this.restartingRuntime.clearAndLeak();
			} catch (error) {
				this.log.error('app-server.reload', 'Development runtime restart failed', { ...detail, phase, durationMillis: Math.round(performance.now() - started) }, error);
				if (this.isDisposed || !previous) throw error;
				failure = { error };
				const carrier = [...this.connections][0];
				try {
					for (const { launcher } of this.connections) launcher.selectDevelopmentRuntime(previous);
					if (phase === 'restarting-daemon' && carrier) await restartDaemon(carrier.launcher);
				} catch (rollbackError) {
					this.log.error('app-server.reload', 'Development runtime rollback failed', detail, rollbackError);
					throw new AggregateError([error, rollbackError], 'Development runtime restart and rollback failed');
				}
			} finally {
				// An unselected candidate still needs its lease for the stop command.
				// A selected candidate is protected through reconnect by the drain.
				if (this.selectedRuntime.value !== lease) await preflightCleanup;
				this.restartingRuntime.clear();
				this.restartBarrier = undefined;
				release();
			}
			try {
				if (this.isDisposed) return;
				const results = await Promise.allSettled(running.filter(connection => this.connections.has(connection)).map(async connection => {
					await connection.supervisor.start();
					this.reconnecting.delete(connection);
				}));
				for (const result of results) if (result.status === 'rejected') throw result.reason;
				this.log.info('app-server.reload', failure ? 'Previous development runtime restored' : 'Development runtime restart completed', { ...detail, durationMillis: Math.round(performance.now() - started) });
			} catch (error) {
				this.log.error('app-server.reload', 'Development runtime restart failed', { ...detail, phase: 'reconnecting', durationMillis: Math.round(performance.now() - started) }, error);
				throw error;
			} finally {
				// Reconnect can use the live profile as soon as it is ready. Keep
				// publications serialized until the isolated profile is cleaned up.
				await preflightCleanup;
			}
			if (failure) throw failure.error;
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
	// Select the leased development generation explicitly. A profile may already
	// have an installed package, which the ordinary restart command prefers.
	await execFileAsync(launcher.executable, ['ensure-selected'], { env: { ...launcher.environment }, maxBuffer: 1_048_576, timeout: 40_000, windowsHide: true });
}

async function preflightManagedDaemon(launcher: AppServerDaemonLauncher, lease: IDevelopmentAppServerRuntime): Promise<SuccessfulPreflight> {
	lease.assertActive();
	const profile = await mkdtemp(join(tmpdir(), 'ash-'));
	const bin = join(lease.runtime, 'bin');
	const suffix = process.platform === 'win32' ? '.exe' : '';
	const executable = join(bin, `ash-app-server-daemon${suffix}`);
	const env: NodeJS.ProcessEnv = {
		...launcher.environment,
		ASH_HOME: profile,
		ASH_APP_SERVER_PATH: join(bin, `ash-app-server${suffix}`),
		ASH_DEV_RUNTIME_ROOT: lease.runtime,
		ASH_USE_INMEMORY_SECRETSTORAGE: '1',
	};
	for (const key of ['ASH_WORKSPACE_ROOT', 'ASH_DIR_GRANT_SOURCE', 'ASH_APP_SERVER_CONNECTION_ROLE', 'ASH_REMOTE_HOST', 'ASH_REMOTE_ROOT', 'ASH_REMOTE_RUNTIME']) delete env[key];
	const options = { env, maxBuffer: 1_048_576, timeout: 40_000, windowsHide: true };
	async function cleanup(): Promise<void> {
		await execFileAsync(executable, ['stop'], options);
		await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}

	try {
		// This command verifies the selected process identity and runs a full initialize
		// with the candidate daemon's expected schema and required capabilities.
		await execFileAsync(executable, ['ensure-selected'], options);
	} catch (error) {
		try { await cleanup(); }
		catch (cleanupError) {
			throw new AggregateError([error, cleanupError], `Preflight startup and cleanup failed for ${profile}`);
		}
		throw error;
	}
	return { cleanup: cleanup() };
}

function watchGenerationFile(generationFile: string, listener: () => void): IDisposable {
	// Publication atomically replaces this small pointer. Native directory watches
	// can silently miss it, leaving every window on the old runtime indefinitely.
	// Stat polling avoids that dependency; reloadNow still validates and leases the generation.
	watchFile(generationFile, { persistent: false, interval: 100 }, listener);
	return toDisposable(() => unwatchFile(generationFile, listener));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
