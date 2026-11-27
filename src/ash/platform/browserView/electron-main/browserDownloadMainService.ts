import { localize } from '../../../nls.js';
import { app, dialog, type DownloadItem } from 'electron/main';
import { shell } from 'electron';
import { basename, extname, isAbsolute, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { Lazy } from '../../../base/common/lazy.js';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { isRecord } from '../../../base/common/types.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { StorageScope, StorageTarget, WillSaveStateReason } from '../../storage/common/storage.js';
import { ILogService } from '../../log/common/log.js';
import { IBrowserDownloadService, type BrowserDownload, type BrowserDownloadState } from '../common/browserDownloads.js';

const identity = { scope: StorageScope.APPLICATION, id: 'application' };
const historyKey = 'browser.downloads';
const states = new Set(['completed', 'cancelled', 'interrupted', 'deleted']);

/** Owns browser download records and file mutations across all Desktop windows. */
export class BrowserDownloadMainService extends Disposable implements IBrowserDownloadService {
	private readonly changes = this._register(new Emitter<void>());
	readonly onDidChange = this.changes.event;
	private readonly items = new Map<string, BrowserDownload>();
	private readonly active = new Map<string, { item: DownloadItem; cleanup: () => void; }>();
	private readonly reservedPaths = new Set<string>();
	private readonly progressChanged = this._register(new RunOnceScheduler(() => this.changes.fire(), 100));
	private readonly save = this._register(new RunOnceScheduler(() => this.persist(), 500));
	private initialization: Promise<void> | undefined;
	private configuredDirectory: string | undefined;
	private readonly defaultDirectory = new Lazy(() => {
		try {
			return app.getPath('downloads');
		} catch (error) {
			// The Windows known folder can be unavailable in an isolated profile.
			this.log.warn('browserDownloads', error);
			return join(app.getPath('home'), 'Downloads');
		}
	});
	private ask = true;
	private loaded = false;
	private isStorageClosing = false;
	constructor(
		@IApplicationStorageMainService private readonly storage: IApplicationStorageMainService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this._register(storage.onWillSaveState(({ reason }) => {
			this.persist();
			if (reason === WillSaveStateReason.SHUTDOWN) {
				this.isStorageClosing = true;
				this.save.cancel();
			}
		}));
	}

	initialize(): Promise<void> {
		return this.initialization ??= this.restore().then(() => { this.loaded = true; });
	}
	private get directory(): string { return this.configuredDirectory ?? this.defaultDirectory.value; }
	private async restore(): Promise<void> {
		const raw = (await this.storage.getItems(identity)).entries[historyKey]?.value;
		if (!raw) return;
		const values: unknown = JSON.parse(raw);
		if (!Array.isArray(values) || values.length > 1000) throw new TypeError('Invalid browser download history');
		for (const value of values) {
			if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(value.id)
				|| typeof value.filename !== 'string' || value.filename.length > 4096 || typeof value.url !== 'string' || value.url.length > 32768
				|| typeof value.path !== 'string' || value.path.includes('\0') || value.path && !isAbsolute(value.path)
				|| typeof value.time !== 'number' || !Number.isFinite(value.time) || typeof value.receivedBytes !== 'number' || value.receivedBytes < 0
				|| !Number.isSafeInteger(value.receivedBytes) || typeof value.totalBytes !== 'number' || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 || typeof value.state !== 'string' || !states.has(value.state)) throw new TypeError('Invalid browser download record');
			// Downloads started during restoration take precedence over older disk records.
			if (!this.items.has(value.id)) this.items.set(value.id, value as unknown as BrowserDownload);
		}
		this.changes.fire();
	}
	async configure(directory: string, ask: boolean): Promise<void> {
		if (typeof directory !== 'string' || directory.length > 32768 || directory.includes('\0') || directory && !isAbsolute(directory) || typeof ask !== 'boolean') throw new TypeError('Invalid browser download settings');
		this.configuredDirectory = directory || undefined;
		this.ask = ask;
		this.changes.fire();
	}
	async getState(): Promise<BrowserDownloadState> {
		await this.initialize();
		return { directory: this.directory, items: [...this.items.values()].sort((a, b) => b.time - a.time) };
	}
	async chooseDirectory(): Promise<string | undefined> {
		return (await dialog.showOpenDialog({ defaultPath: this.directory, properties: ['openDirectory', 'createDirectory'] })).filePaths[0];
	}
	/** Called synchronously by the page permission gate before Electron starts saving. */
	track(item: DownloadItem): boolean {
		const id = randomUUID();
		const filename = basename(item.getFilename().replaceAll('\\', '/')) || 'download';
		const directory = this.directory;
		let path = join(directory, filename);
		if (this.ask) item.setSaveDialogOptions({ defaultPath: path });
		else {
			try {
				mkdirSync(directory, { recursive: true });
				const extension = extname(filename);
				const stem = filename.slice(0, filename.length - extension.length);
				let suffix = 1;
				while (existsSync(path) || this.reservedPaths.has(path)) path = join(directory, `${stem} (${suffix++})${extension}`);
				this.reservedPaths.add(path);
				item.setSavePath(path);
			} catch (error) {
				this.reservedPaths.delete(path);
				this.items.set(id, {
					id, filename, url: item.getURLChain()[0] ?? item.getURL(), path: '', time: Date.now(),
					receivedBytes: 0, totalBytes: item.getTotalBytes(), state: 'interrupted'
				});
				item.cancel();
				this.log.error('browserDownloads', error);
				this.progressChanged.schedule(); this.save.schedule();
				return false;
			}
		}
		const time = Date.now();
		const update = (state: BrowserDownload['state']): void => {
			const savedPath = item.getSavePath();
			this.items.set(id, {
				id, filename: savedPath ? basename(savedPath) : filename, url: item.getURLChain()[0] ?? item.getURL(), path: savedPath, time,
				receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), state
			});
			this.progressChanged.schedule();
			this.save.schedule();
		};
		const updated = (_event: Electron.Event, state: 'progressing' | 'interrupted'): void => update(state);
		const done = (_event: Electron.Event, state: 'completed' | 'cancelled' | 'interrupted'): void => {
			update(state); cleanup(); this.active.delete(id); this.reservedPaths.delete(path);
			for (const entry of [...this.items.values()].sort((a, b) => a.time - b.time)) {
				if (this.items.size <= 1000) break;
				if (!this.active.has(entry.id)) this.items.delete(entry.id);
			}
		};
		const cleanup = (): void => { item.removeListener('updated', updated); item.removeListener('done', done); };
		this.active.set(id, { item, cleanup });
		item.on('updated', updated); item.once('done', done);
		update('progressing');
		return true;
	}
	async perform(id: string, action: 'open' | 'show' | 'deleteFile' | 'remove'): Promise<void> {
		await this.initialize();
		const entry = this.items.get(id);
		if (!entry) throw new Error(localize({ bundle: 'ash', key: 'downloads.unavailable' }, 'This download record is unavailable.'));
		if (this.active.has(id)) throw new Error(localize({ bundle: 'ash', key: 'downloads.active' }, 'Wait for the download to finish before changing its file or record.'));
		if (action === 'remove') this.items.delete(id);
		else {
			if (!entry.path || entry.state !== 'completed' || !existsSync(entry.path)) throw new Error(localize({ bundle: 'ash', key: 'downloads.fileUnavailable' }, 'The downloaded file is unavailable.'));
			if (action === 'open') { const error = await shell.openPath(entry.path); if (error) throw new Error(error); }
			else if (action === 'show') shell.showItemInFolder(entry.path);
			else if (action === 'deleteFile') { await shell.trashItem(entry.path); this.items.set(id, { ...entry, state: 'deleted' }); }
			else throw new TypeError('Invalid download action');
		}
		this.changes.fire(); this.persist();
	}
	private persist(): void {
		if (!this.loaded || this.isStorageClosing) { return; }
		const values = [...this.items.values()].sort((a, b) => b.time - a.time).slice(0, 1000)
			.map(entry => entry.state === 'progressing' ? { ...entry, state: 'interrupted' } : entry);
		// Enqueue synchronously so the application storage's shutdown barrier includes this write.
		void this.storage.updateItems(identity, historyKey, { value: JSON.stringify(values), target: StorageTarget.MACHINE })
			.catch(error => this.log.error('browserDownloads', error));
	}
	protected override disposeCore(): void {
		for (const { item, cleanup } of this.active.values()) { cleanup(); item.cancel(); }
		this.active.clear();
		super.disposeCore();
	}
}
