import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron/main';
import { AbstractDisposable } from '../../../base/common/lifecycle.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import { UPDATE_AUTO_CHECK_CHANNEL, UPDATE_CHECK_CHANNEL, UPDATE_DOWNLOAD_CHANNEL, UPDATE_INSTALL_CHANNEL, validateInstallRequest, validateUpdateRequest, type UpdateCheckResult, type UpdateReadyResult } from '../common/updateService.js';

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
	private readonly children = new Set<ChildProcessWithoutNullStreams>();
	private readonly checking = new Map<'latest' | 'stable', Promise<UpdateCheckResult>>();
	private downloading: Promise<UpdateReadyResult> | undefined;
	private lastAutomaticCheck = 0;
	private staged: StagedUpdate | undefined;
	private installing = false;

	constructor() {
		super();
		if (app.isPackaged && process.platform === 'darwin') {
			void this.cleanupPreviousMacUpdate().catch(error => console.error('Could not clean up previous Ash update', error));
		}
	}

	public checkForUpdates(policy: 'latest' | 'stable'): Promise<UpdateCheckResult> {
		this.assertNotDisposed();
		let checking = this.checking.get(policy);
		if (!checking) {
			checking = this.check(policy).finally(() => { this.checking.delete(policy); });
			this.checking.set(policy, checking);
		}
		return checking;
	}

	public checkAutomatically(policy: 'latest' | 'stable'): Promise<UpdateCheckResult | undefined> {
		this.assertNotDisposed();
		if (!app.isPackaged || Date.now() - this.lastAutomaticCheck < 24 * 60 * 60 * 1000) return Promise.resolve(undefined);
		this.lastAutomaticCheck = Date.now();
		return this.checkForUpdates(policy);
	}

	public downloadUpdate(policy: 'latest' | 'stable'): Promise<UpdateReadyResult> {
		this.assertNotDisposed();
		if (!app.isPackaged) throw new Error('Desktop updates require an installed Ash application');
		if (this.installing) throw new Error('An update is already being installed');
		if (!this.downloading) {
			this.downloading = this.download(policy).finally(() => { this.downloading = undefined; });
		}
		return this.downloading;
	}

	public async installUpdate(): Promise<void> {
		this.assertNotDisposed();
		if (!app.isPackaged) throw new Error('Desktop updates require an installed Ash application');
		if (this.installing || this.downloading) throw new Error('The update is not ready to install');
		const staged = this.staged;
		if (!staged) throw new Error('No verified desktop update has been downloaded');
		this.installing = true;
		try {
			await verifyStaged(staged);
			if (process.platform === 'win32') await this.installWindows(staged);
			else if (process.platform === 'darwin') await this.installMac(staged);
			else throw new Error('Desktop installation is unavailable on this platform');
		} catch (error) {
			this.installing = false;
			throw error;
		}
	}

	protected override disposeCore(): void {
		for (const child of this.children) child.kill();
		this.children.clear();
	}

	private async check(policy: 'latest' | 'stable'): Promise<UpdateCheckResult> {
		const { executable, request } = await this.hostRequest('check', policy);
		return validateCheckResult(await this.runHost(executable, request, 40_000));
	}

	private async download(policy: 'latest' | 'stable'): Promise<UpdateReadyResult> {
		const root = join(app.getPath('userData'), 'updates');
		await mkdir(root, { recursive: true });
		const directory = await mkdtemp(join(root, 'release-'));
		try {
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

	private async hostRequest(command: 'check' | 'download', policy: 'latest' | 'stable', stagingDirectory?: string): Promise<{ executable: string; request: object }> {
		if (process.platform !== 'win32' && process.platform !== 'darwin') {
			throw new Error('Desktop updates are unavailable on this platform');
		}
		const target = process.platform === 'win32'
			? 'x86_64-pc-windows-msvc'
			: process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
		const key = app.isPackaged
			? (await readFile(join(process.resourcesPath, 'update-public-key'), 'utf8')).trim()
			: process.env.ASH_UPDATE_PUBLIC_KEY;
		if (!key || !/^[a-fA-F0-9]{64}$/.test(key)) {
			throw new Error('Ash Desktop update public key is not configured');
		}
		const executable = app.isPackaged
			? join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'ash-update-host.exe' : 'ash-update-host')
			: join(app.getAppPath(), '..', '.build', 'cargo', 'debug', process.platform === 'win32' ? 'ash-update-host.exe' : 'ash-update-host');
		return { executable, request: { command, currentVersion: app.getVersion(), publicKey: key, target, policy, ...(stagingDirectory ? { stagingDirectory } : {}) } };
	}

	private runHost(executable: string, request: object, timeoutMs: number): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const child = spawn(executable, [], { stdio: 'pipe', windowsHide: true });
			this.children.add(child);
			let stdout = '';
			let stderr = '';
			let timedOut = false;
			const timeout = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdin.on('error', error => { reject(error); child.kill(); });
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
				if (timedOut) { reject(new Error('Update operation timed out')); return; }
				if (code !== 0) { reject(new Error(stderr.trim() || `Update host exited with code ${code}`)); return; }
				try { resolve(JSON.parse(stdout)); }
				catch (error) { reject(error); }
			});
			child.stdin.end(JSON.stringify(request));
		});
	}

	private async installWindows(staged: StagedUpdate): Promise<void> {
		if (!staged.filePath.endsWith('.exe')) throw new Error('Verified Windows update is not an installer');
		await new Promise<void>((resolveSpawn, reject) => {
			const installer = spawn(staged.filePath, ['/SP-', '/SILENT', '/NORESTART', '/CLOSEAPPLICATIONS', '/NORESTARTAPPLICATIONS'], {
				detached: true, stdio: 'ignore', windowsHide: true,
			});
			installer.once('error', reject);
			installer.once('spawn', () => { installer.unref(); resolveSpawn(); });
		});
		app.quit();
	}

	private async installMac(staged: StagedUpdate): Promise<void> {
		if (!staged.filePath.endsWith('.zip')) throw new Error('Verified macOS update is not a ZIP package');
		const current = resolve(process.resourcesPath, '..', '..');
		if (basename(current) !== 'Ash.app') throw new Error('Ash is not running from its installed application bundle');
		const extraction = join(staged.directory, 'extracted');
		await mkdir(extraction);
		await runFile('ditto', ['-x', '-k', staged.filePath, extraction], { timeout: 300_000 });
		const entries = await readdir(extraction);
		if (entries.length !== 1 || entries[0] !== 'Ash.app') throw new Error('Verified macOS update has an unexpected bundle layout');
		const replacement = join(dirname(current), `.Ash-update-new-${randomUUID()}.app`);
		const previous = join(dirname(current), `.Ash-update-backup-${randomUUID()}.app`);
		const marker = join(app.getPath('userData'), 'updates', 'mac-cleanup.json');
		try {
			await runFile('ditto', [join(extraction, 'Ash.app'), replacement], { timeout: 300_000 });
			await runFile('codesign', ['--verify', '--deep', '--strict', replacement], { timeout: 120_000 });
			await writeFile(marker, JSON.stringify({ current, previous }));
			try {
				await rename(current, previous);
				try { await rename(replacement, current); }
				catch (error) { await rename(previous, current); throw error; }
			} catch (error) {
				await rm(marker, { force: true });
				throw error;
			}
			app.relaunch();
			app.quit();
		} finally {
			await rm(replacement, { recursive: true, force: true });
		}
	}

	private async cleanupPreviousMacUpdate(): Promise<void> {
		const marker = join(app.getPath('userData'), 'updates', 'mac-cleanup.json');
		let record: { current: string; previous: string };
		try { record = JSON.parse(await readFile(marker, 'utf8')); }
		catch (error) { if (isMissing(error)) return; throw error; }
		const current = resolve(process.resourcesPath, '..', '..');
		if (record.current !== current || dirname(record.previous) !== dirname(current)
			|| !/^\.Ash-update-backup-[0-9a-f-]+\.app$/.test(basename(record.previous))) {
			throw new Error('Previous update cleanup path is invalid');
		}
		await rm(record.previous, { recursive: true, force: true });
		await rm(marker);
	}
}

function validateCheckResult(value: unknown): UpdateCheckResult {
	if (!value || typeof value !== 'object') throw new TypeError('Invalid update check result');
	const result = value as Record<string, unknown>;
	if (result.status === 'current' && typeof result.version === 'string') return { status: 'current', version: result.version };
	if (result.status === 'available' && typeof result.currentVersion === 'string' && typeof result.version === 'string') {
		return { status: 'available', currentVersion: result.currentVersion, version: result.version };
	}
	throw new TypeError('Invalid update check result');
}

function validateDownloadResult(value: unknown, directory: string): StagedUpdate {
	if (!value || typeof value !== 'object') throw new TypeError('Invalid update download result');
	const result = value as Record<string, unknown>;
	if (typeof result.version !== 'string' || typeof result.filePath !== 'string' || typeof result.size !== 'number'
		|| !Number.isSafeInteger(result.size) || result.size < 1 || result.size > MAX_PACKAGE_BYTES
		|| typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256)
		|| dirname(resolve(result.filePath)) !== resolve(directory)) {
		throw new TypeError('Invalid update download result');
	}
	return { version: result.version, filePath: result.filePath, size: result.size, sha256: result.sha256, directory };
}

async function verifyStaged(staged: StagedUpdate): Promise<void> {
	const metadata = await lstat(staged.filePath);
	if (!metadata.isFile() || metadata.size !== staged.size) throw new Error('Staged desktop update has changed');
	const digest = createHash('sha256');
	for await (const chunk of createReadStream(staged.filePath)) digest.update(chunk);
	if (digest.digest('hex') !== staged.sha256) throw new Error('Staged desktop update does not match its signed SHA-256');
}

async function removeStage(directory: string, root: string): Promise<void> {
	const absoluteRoot = await realpath(root);
	const absoluteDirectory = await realpath(directory);
	if (dirname(absoluteDirectory) !== absoluteRoot || !basename(absoluteDirectory).startsWith('release-')) {
		throw new Error('Update staging directory is outside the application update root');
	}
	await rm(absoluteDirectory, { recursive: true, force: true });
}

function isMissing(error: unknown): boolean {
	return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

export function updateIpcRoutes(service: UpdateMainService): readonly IpcRoute<unknown, unknown>[] {
	return [
		{ channel: UPDATE_CHECK_CHANNEL, validate: validateUpdateRequest, invoke: policy => service.checkForUpdates(policy) },
		{ channel: UPDATE_AUTO_CHECK_CHANNEL, validate: validateUpdateRequest, invoke: policy => service.checkAutomatically(policy) },
		{ channel: UPDATE_DOWNLOAD_CHANNEL, validate: validateUpdateRequest, invoke: policy => service.downloadUpdate(policy) },
		{ channel: UPDATE_INSTALL_CHANNEL, validate: validateInstallRequest, invoke: () => service.installUpdate() },
	];
}
