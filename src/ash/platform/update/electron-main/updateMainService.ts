import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { App } from 'electron/main';
import { AbstractDisposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { IMeteredConnectionService } from '../../meteredConnection/common/meteredConnection.js';
import type { UpdateCheckResult, UpdateReadyResult, UpdateState } from '../common/updateService.js';

const MAX_OUTPUT_BYTES = 4096;
const MAX_PACKAGE_BYTES = 4 * 1024 * 1024 * 1024;
const runFile = promisify(execFile);

interface StagedUpdate {
	readonly version: string;
	readonly filePath: string;
	readonly size: number;
	readonly sha256: string;
	readonly directory: string;
}

/** Owns the installed Electron product's update process and installer handoff. */
export class UpdateMainService extends AbstractDisposable {
	private readonly stateChanges = new Emitter<UpdateState>();
	readonly onDidChangeState = this.stateChanges.event;
	private readonly children = new Set<ChildProcessWithoutNullStreams>();
	private readonly checking = new Map<'latest' | 'stable', Promise<UpdateCheckResult>>();
	private downloading: Promise<UpdateReadyResult> | undefined;
	private lastAutomaticCheck = 0;
	private staged: StagedUpdate | undefined;
	private installing = false;
	private readonly cleanup: Promise<void>;
	get state(): UpdateState {
		return this.installing ? 'installing' : this.downloading ? 'downloading' : this.staged ? 'ready' : 'idle';
	}

	constructor(
		private readonly prepareRestart: (version: string) => Promise<void>,
		private readonly application: Pick<
			App,
			'isPackaged' | 'getPath' | 'getVersion' | 'getAppPath' | 'quit' | 'relaunch'
		>,
		@IMeteredConnectionService private readonly meteredConnection: IMeteredConnectionService,
	) {
		super();
		this.cleanup = application.isPackaged
			? this.cleanupStaleDownloads().catch(error =>
					console.error('Could not clean up previous Ash downloads', error),
				)
			: Promise.resolve();
		if (application.isPackaged && process.platform === 'darwin') {
			void this.cleanupPreviousMacUpdate().catch(error =>
				console.error('Could not clean up previous Ash update', error),
			);
		}
	}

	public checkForUpdates(policy: 'latest' | 'stable'): Promise<UpdateCheckResult> {
		this.assertNotDisposed();
		let checking = this.checking.get(policy);
		if (!checking) {
			checking = this.check(policy).finally(() => {
				this.checking.delete(policy);
			});
			this.checking.set(policy, checking);
		}
		return checking;
	}

	public async checkAutomatically(policy: 'latest' | 'stable'): Promise<UpdateCheckResult | undefined> {
		this.assertNotDisposed();
		await this.cleanup;
		if (!this.application.isPackaged) return undefined;
		await this.meteredConnection.whenConnectionStateInitialized;
		this.assertNotDisposed();
		// A skipped check must not consume the shared cooldown: reconnecting
		// to an unmetered network should allow the postponed check immediately.
		if (this.meteredConnection.isConnectionMetered || Date.now() - this.lastAutomaticCheck < 24 * 60 * 60 * 1000)
			return undefined;
		this.lastAutomaticCheck = Date.now();
		return this.checkForUpdates(policy);
	}

	public downloadUpdate(policy: 'latest' | 'stable'): Promise<UpdateReadyResult> {
		this.assertNotDisposed();
		if (!this.application.isPackaged) throw new Error('Desktop updates require an installed Ash application');
		if (this.installing) throw new Error('An update is already being installed');
		if (!this.downloading) {
			this.downloading = this.download(policy).finally(() => {
				this.downloading = undefined;
				if (!this.isDisposed) this.stateChanges.fire(this.state);
			});
			this.stateChanges.fire(this.state);
		}
		return this.downloading;
	}

	public async installUpdate(): Promise<void> {
		this.assertNotDisposed();
		if (!this.application.isPackaged) throw new Error('Desktop updates require an installed Ash application');
		if (this.installing || this.downloading) throw new Error('The update is not ready to install');
		const staged = this.staged;
		if (!staged) throw new Error('No verified desktop update has been downloaded');
		this.installing = true;
		this.stateChanges.fire(this.state);
		try {
			await verifyStaged(staged);
			await this.prepareRestart(staged.version);
			if (process.platform === 'win32') await this.installWindows(staged);
			else if (process.platform === 'darwin') await this.installMac(staged);
			else throw new Error('Desktop installation is unavailable on this platform');
		} catch (error) {
			this.installing = false;
			if (!this.isDisposed) this.stateChanges.fire(this.state);
			throw error;
		}
	}

	protected override disposeCore(): void {
		this.stateChanges.dispose();
		for (const child of this.children) child.kill();
		this.children.clear();
	}

	private async check(policy: 'latest' | 'stable'): Promise<UpdateCheckResult> {
		const { executable, request } = await this.hostRequest('check', policy);
		return validateCheckResult(await this.runHost(executable, request, 40_000));
	}

	private async download(policy: 'latest' | 'stable'): Promise<UpdateReadyResult> {
		await this.cleanup;
		const root = join(this.application.getPath('userData'), 'updates');
		await mkdir(root, { recursive: true });
		const directory = await mkdtemp(join(root, 'release-'));
		try {
			await writeFile(
				join(directory, 'stage.json'),
				JSON.stringify({ schemaVersion: 1, product: 'ash-desktop' }),
				{ flag: 'wx' },
			);
			const { executable, request } = await this.hostRequest('download', policy, directory);
			const staged = validateDownloadResult(await this.runHost(executable, request, 900_000), directory);
			await verifyStaged(staged);
			const previous = this.staged;
			if (previous) await removeStage(previous.directory, root);
			this.staged = staged;
			return { version: staged.version };
		} catch (error) {
			await removeStage(directory, root);
			throw error;
		}
	}

	private async cleanupStaleDownloads(): Promise<void> {
		const root = join(this.application.getPath('userData'), 'updates');
		let entries: string[];
		try {
			if ((await realpath(root)) !== resolve(root)) return;
			entries = await readdir(root);
		} catch (error) {
			if (isMissing(error)) return;
			throw error;
		}
		for (const name of entries) {
			if (!/^release-[a-zA-Z0-9]+$/.test(name)) continue;
			const directory = join(root, name);
			const metadata = await lstat(directory);
			if (!metadata.isDirectory() || metadata.isSymbolicLink() || !(await disposableUpdateTree(directory)))
				continue;
			let owned = false;
			try {
				const marker = await lstat(join(directory, 'stage.json'));
				if (marker.isFile() && !marker.isSymbolicLink() && marker.size < 1024) {
					const value = JSON.parse(await readFile(join(directory, 'stage.json'), 'utf8'));
					owned = value.schemaVersion === 1 && value.product === 'ash-desktop';
				}
			} catch (error) {
				if (!isMissing(error)) continue;
				// Older releases had no receipt. Only recognize an otherwise
				// empty directory containing a shipped download filename.
				const files = await readdir(directory);
				owned =
					files.length === 1 &&
					/^(AshSetup-\d+\.\d+\.\d+-win32-x64\.exe|Ash-darwin-(arm64|x64)\.zip)$/.test(files[0]!);
			}
			if (owned) {
				try {
					await removeStage(directory, root);
				} catch (error) {
					// The Windows installer can still hold its downloaded image
					// during application restart. Leave it for the next cleanup.
					console.error(`Could not remove Ash update download ${directory}`, error);
				}
			}
		}
	}

	private async hostRequest(
		command: 'check' | 'download',
		policy: 'latest' | 'stable',
		stagingDirectory?: string,
	): Promise<{ executable: string; request: object }> {
		if (process.platform !== 'win32' && process.platform !== 'darwin') {
			throw new Error('Desktop updates are unavailable on this platform');
		}
		const target =
			process.platform === 'win32'
				? 'x86_64-pc-windows-msvc'
				: process.arch === 'arm64'
					? 'aarch64-apple-darwin'
					: 'x86_64-apple-darwin';
		const key = this.application.isPackaged
			? (await readFile(join(process.resourcesPath, 'update-public-key'), 'utf8')).trim()
			: process.env.ASH_UPDATE_PUBLIC_KEY;
		if (!key || !/^[a-fA-F0-9]{64}$/.test(key)) {
			throw new Error('Ash Desktop update public key is not configured');
		}
		const executable = this.application.isPackaged
			? join(
					process.resourcesPath,
					'bin',
					process.platform === 'win32' ? 'ash-update-host.exe' : 'ash-update-host',
				)
			: join(
					this.application.getAppPath(),
					'.build',
					'cargo',
					'debug',
					process.platform === 'win32' ? 'ash-update-host.exe' : 'ash-update-host',
				);
		return {
			executable,
			request: {
				command,
				currentVersion: this.application.getVersion(),
				publicKey: key,
				target,
				policy,
				...(stagingDirectory ? { stagingDirectory } : {}),
			},
		};
	}

	private runHost(executable: string, request: object, timeoutMs: number): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const child = spawn(executable, [], { stdio: 'pipe', windowsHide: true });
			this.children.add(child);
			let stdout = '';
			let stderr = '';
			let timedOut = false;
			const timeout = setTimeout(() => {
				timedOut = true;
				child.kill();
			}, timeoutMs);
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdin.on('error', error => {
				reject(error);
				child.kill();
			});
			child.stdout.on('data', (chunk: string) => {
				stdout += chunk;
				if (stdout.length > MAX_OUTPUT_BYTES) child.kill();
			});
			child.stderr.on('data', (chunk: string) => {
				stderr += chunk;
				if (stderr.length > MAX_OUTPUT_BYTES) child.kill();
			});
			child.on('error', error => {
				clearTimeout(timeout);
				this.children.delete(child);
				reject(error);
			});
			child.on('close', code => {
				clearTimeout(timeout);
				this.children.delete(child);
				if (timedOut) {
					reject(new Error('Update operation timed out'));
					return;
				}
				if (code !== 0) {
					reject(new Error(stderr.trim() || `Update host exited with code ${code}`));
					return;
				}
				try {
					resolve(JSON.parse(stdout));
				} catch (error) {
					reject(error);
				}
			});
			child.stdin.end(JSON.stringify(request));
		});
	}

	private async installWindows(staged: StagedUpdate): Promise<void> {
		if (!staged.filePath.endsWith('.exe')) throw new Error('Verified Windows update is not an installer');
		await new Promise<void>((resolveSpawn, reject) => {
			const installer = spawn(
				staged.filePath,
				['/SP-', '/SILENT', '/NORESTART', '/CLOSEAPPLICATIONS', '/NORESTARTAPPLICATIONS', '/ASHRESTART=yes'],
				{ detached: true, stdio: 'ignore', windowsHide: true },
			);
			installer.once('error', reject);
			installer.once('spawn', () => {
				installer.unref();
				resolveSpawn();
			});
		});
		this.application.quit();
	}

	private async installMac(staged: StagedUpdate): Promise<void> {
		if (!staged.filePath.endsWith('.zip')) throw new Error('Verified macOS update is not a ZIP package');
		const current = resolve(process.resourcesPath, '..', '..');
		if (basename(current) !== 'Ash.app')
			throw new Error('Ash is not running from its installed application bundle');
		const extraction = join(staged.directory, 'extracted');
		await mkdir(extraction);
		await runFile('ditto', ['-x', '-k', staged.filePath, extraction], { timeout: 300_000 });
		const entries = await readdir(extraction);
		if (entries.length !== 1 || entries[0] !== 'Ash.app')
			throw new Error('Verified macOS update has an unexpected bundle layout');
		const replacement = join(dirname(current), `.Ash-update-new-${randomUUID()}.app`);
		const previous = join(dirname(current), `.Ash-update-backup-${randomUUID()}.app`);
		const marker = join(this.application.getPath('userData'), 'updates', 'mac-cleanup.json');
		try {
			await runFile('ditto', [join(extraction, 'Ash.app'), replacement], { timeout: 300_000 });
			await runFile('codesign', ['--verify', '--deep', '--strict', replacement], { timeout: 120_000 });
			await writeFile(marker, JSON.stringify({ current, previous }));
			try {
				await rename(current, previous);
				try {
					await rename(replacement, current);
				} catch (error) {
					await rename(previous, current);
					throw error;
				}
			} catch (error) {
				await rm(marker, { force: true });
				throw error;
			}
			this.application.relaunch();
			this.application.quit();
		} finally {
			await rm(replacement, { recursive: true, force: true });
		}
	}

	private async cleanupPreviousMacUpdate(): Promise<void> {
		const marker = join(this.application.getPath('userData'), 'updates', 'mac-cleanup.json');
		let record: { current: string; previous: string };
		try {
			record = JSON.parse(await readFile(marker, 'utf8'));
		} catch (error) {
			if (isMissing(error)) return;
			throw error;
		}
		const current = resolve(process.resourcesPath, '..', '..');
		if (
			record.current !== current ||
			dirname(record.previous) !== dirname(current) ||
			!/^\.Ash-update-backup-[0-9a-f-]+\.app$/.test(basename(record.previous))
		) {
			throw new Error('Previous update cleanup path is invalid');
		}
		const previous = await lstat(record.previous).catch(error => {
			if (isMissing(error)) return undefined;
			throw error;
		});
		if (previous) {
			if (!previous.isDirectory() || previous.isSymbolicLink() || (await containsRepository(record.previous)))
				throw new Error('Previous update contains protected user files');
			// Framework links are normal in a signed macOS bundle. Verify the whole
			// resource envelope before unlinking it; never follow those links.
			await runFile('codesign', ['--verify', '--deep', '--strict', record.previous], { timeout: 120_000 });
		}
		await rm(record.previous, { recursive: true, force: true });
		await rm(marker);
	}
}

function validateCheckResult(value: unknown): UpdateCheckResult {
	if (!value || typeof value !== 'object') throw new TypeError('Invalid update check result');
	const result = value as Record<string, unknown>;
	if (result.status === 'current' && typeof result.version === 'string')
		return { status: 'current', version: result.version };
	if (
		result.status === 'available' &&
		typeof result.currentVersion === 'string' &&
		typeof result.version === 'string'
	) {
		return { status: 'available', currentVersion: result.currentVersion, version: result.version };
	}
	throw new TypeError('Invalid update check result');
}

function validateDownloadResult(value: unknown, directory: string): StagedUpdate {
	if (!value || typeof value !== 'object') throw new TypeError('Invalid update download result');
	const result = value as Record<string, unknown>;
	if (
		typeof result.version !== 'string' ||
		typeof result.filePath !== 'string' ||
		typeof result.size !== 'number' ||
		!Number.isSafeInteger(result.size) ||
		result.size < 1 ||
		result.size > MAX_PACKAGE_BYTES ||
		typeof result.sha256 !== 'string' ||
		!/^[a-f0-9]{64}$/.test(result.sha256) ||
		dirname(resolve(result.filePath)) !== resolve(directory)
	) {
		throw new TypeError('Invalid update download result');
	}
	return { version: result.version, filePath: result.filePath, size: result.size, sha256: result.sha256, directory };
}

async function verifyStaged(staged: StagedUpdate): Promise<void> {
	const metadata = await lstat(staged.filePath);
	if (!metadata.isFile() || metadata.size !== staged.size) throw new Error('Staged desktop update has changed');
	const digest = createHash('sha256');
	for await (const chunk of createReadStream(staged.filePath)) digest.update(chunk);
	if (digest.digest('hex') !== staged.sha256)
		throw new Error('Staged desktop update does not match its signed SHA-256');
}

async function removeStage(directory: string, root: string): Promise<void> {
	const absoluteRoot = await realpath(root);
	const absoluteDirectory = await realpath(directory);
	if (dirname(absoluteDirectory) !== absoluteRoot || !basename(absoluteDirectory).startsWith('release-')) {
		throw new Error('Update staging directory is outside the application update root');
	}
	await rm(absoluteDirectory, { recursive: true, force: true });
}

async function disposableUpdateTree(directory: string, root = directory): Promise<boolean> {
	const entries = await readdir(directory, { withFileTypes: true });
	if (
		entries.some(entry => entry.name === 'HEAD') &&
		entries.some(entry => entry.name === 'objects') &&
		entries.some(entry => entry.name === 'refs')
	)
		return false;
	for (const entry of entries) {
		if (entry.isSymbolicLink()) {
			if (process.platform !== 'darwin') return false;
			// Electron framework links stay inside a macOS bundle. Unlinking an
			// owned extraction is safe; external links remain protected.
			const target = await realpath(join(directory, entry.name)).catch(() => undefined);
			if (!target) return false;
			const nested = relative(await realpath(root), target);
			if (nested === '..' || nested.startsWith('../') || isAbsolute(nested)) return false;
			continue;
		}
		if (['.git', '.hg', '.svn', 'worktrees', 'workspaces', 'repositories'].includes(entry.name.toLowerCase()))
			return false;
		if (entry.isDirectory() && !(await disposableUpdateTree(join(directory, entry.name), root))) return false;
		if (!entry.isDirectory() && !entry.isFile()) return false;
	}
	return true;
}

async function containsRepository(directory: string): Promise<boolean> {
	const entries = await readdir(directory, { withFileTypes: true });
	if (
		entries.some(entry =>
			['.git', '.hg', '.svn', 'worktrees', 'workspaces', 'repositories'].includes(entry.name.toLowerCase()),
		)
	)
		return true;
	if (
		entries.some(entry => entry.name === 'HEAD') &&
		entries.some(entry => entry.name === 'objects') &&
		entries.some(entry => entry.name === 'refs')
	)
		return true;
	for (const entry of entries)
		if (entry.isDirectory() && !entry.isSymbolicLink() && (await containsRepository(join(directory, entry.name))))
			return true;
	return false;
}

function isMissing(error: unknown): boolean {
	return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
