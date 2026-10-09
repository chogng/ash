import type { BrowserWindow } from 'electron';
import type { MessageBoxOptions, MessageBoxReturnValue, OpenDialogOptions, OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue } from '../../../base/parts/sandbox/common/electronTypes.js';
import { access } from 'node:fs/promises';
import { hash } from '../../../base/common/hash.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import type { NativeDialogOperation } from '../../native/common/nativeHost.js';
import { massageMessageBoxOptions } from './dialogMainUtils.js';

export interface ISystemDialogApi {
	showMessageBox(options: MessageBoxOptions, window?: BrowserWindow): Promise<MessageBoxReturnValue>;
	showOpenDialog(options: OpenDialogOptions, window?: BrowserWindow): Promise<OpenDialogReturnValue>;
	showSaveDialog(options: SaveDialogOptions, window?: BrowserWindow): Promise<SaveDialogReturnValue>;
}

/** Owns system dialog ordering and cancellation across Electron windows. */
export class DialogMainService extends Disposable {
	private readonly queues = new Map<number, Promise<unknown>>();
	private readonly fileDialogLocks = new Map<number, Set<number>>();
	private readonly active = new Map<number, Map<number, AbortController>>();
	private readonly closedWindows = new WeakSet<BrowserWindow>();

	constructor(private readonly api: ISystemDialogApi) { super(); }

	async perform(window: BrowserWindow, operation: NativeDialogOperation): Promise<MessageBoxReturnValue | void> {
		this.assertNotDisposed();
		const active = this.active.get(window.id);
		if (operation.kind === 'cancel') {
			active?.get(operation.id)?.abort();
			return;
		}
		if (active?.has(operation.id)) throw new Error('Dialog ID is already active');
		const options = operation.options;
		const cancelled = (): MessageBoxReturnValue => ({ response: options.cancelId ?? 0, checkboxChecked: options.checkboxChecked ?? false });
		const controller = new AbortController();
		const windowActive = active ?? new Map<number, AbortController>();
		windowActive.set(operation.id, controller);
		this.active.set(window.id, windowActive);
		try {
			const result = await this.showMessageBox({ ...options, signal: controller.signal }, window);
			return controller.signal.aborted ? cancelled() : result;
		} catch (error) {
			if (controller.signal.aborted) return cancelled();
			throw error;
		} finally {
			windowActive.delete(operation.id);
			if (windowActive.size === 0) this.active.delete(window.id);
		}
	}

	showMessageBox(options: MessageBoxOptions, window?: BrowserWindow): Promise<MessageBoxReturnValue> {
		return this.enqueue(window, () => {
			if (options.signal?.aborted || window && this.closedWindows.has(window) || this.isDisposed) {
				return Promise.resolve({ response: options.cancelId ?? (options.buttons?.length ?? 1) - 1, checkboxChecked: options.checkboxChecked ?? false });
			}
			const prepared = massageMessageBoxOptions(options);
			return this.api.showMessageBox(prepared.options, window).then(result => {
				if (!prepared.buttonIndices.length) return result;
				const response = prepared.buttonIndices[result.response];
				if (response === undefined) throw new RangeError('System dialog returned an unknown button');
				return { ...result, response };
			});
		});
	}

	showOpenDialog(options: OpenDialogOptions, window?: BrowserWindow): Promise<OpenDialogReturnValue> {
		this.assertNotDisposed();
		const release = this.lockFileDialog(options, window);
		if (!release) return Promise.resolve({ canceled: true, filePaths: [] });
		return this.enqueue(window, async () => {
			if (window && this.closedWindows.has(window) || this.isDisposed) return { canceled: true, filePaths: [] };
			let defaultPath = options.defaultPath;
			if (defaultPath) {
				try { await access(defaultPath); }
				catch { defaultPath = undefined; }
			}
			const result = await this.api.showOpenDialog({ ...options, defaultPath }, window);
			return { ...result, filePaths: result.filePaths.map(path => this.normalizePath(path)) };
		}).finally(release);
	}

	showSaveDialog(options: SaveDialogOptions, window?: BrowserWindow): Promise<SaveDialogReturnValue> {
		this.assertNotDisposed();
		const release = this.lockFileDialog(options, window);
		if (!release) return Promise.resolve({ canceled: true, filePath: '' });
		return this.enqueue(window, async () => {
			if (window && this.closedWindows.has(window) || this.isDisposed) return { canceled: true, filePath: '' };
			const result = await this.api.showSaveDialog(options, window);
			return { ...result, filePath: this.normalizePath(result.filePath) };
		}).finally(release);
	}

	/** A closed window must not leave its queued renderer requests live. */
	cancelWindow(window: BrowserWindow): void {
		this.closedWindows.add(window);
		for (const controller of this.active.get(window.id)?.values() ?? []) controller.abort();
		this.active.delete(window.id);
	}

	private enqueue<T>(window: BrowserWindow | undefined, task: () => Promise<T>): Promise<T> {
		this.assertNotDisposed();
		const id = window?.id ?? 0;
		const previous = this.queues.get(id) ?? Promise.resolve();
		const result = previous.catch(() => undefined).then(task);
		this.queues.set(id, result);
		void result.then(
			() => { if (this.queues.get(id) === result) this.queues.delete(id); },
			() => { if (this.queues.get(id) === result) this.queues.delete(id); },
		);
		return result;
	}

	private lockFileDialog(options: OpenDialogOptions | SaveDialogOptions, window: BrowserWindow | undefined): (() => void) | undefined {
		if (!window) return () => { };
		const windowId = window.id;
		const key = hash(options);
		const locks = this.fileDialogLocks.get(windowId) ?? new Set<number>();
		if (locks.has(key)) return undefined;
		locks.add(key);
		this.fileDialogLocks.set(windowId, locks);
		return () => {
			locks.delete(key);
			if (locks.size === 0) this.fileDialogLocks.delete(windowId);
		};
	}

	private normalizePath(path: string): string;
	private normalizePath(path: string | undefined): string | undefined;
	private normalizePath(path: string | undefined): string | undefined {
		return path && process.platform === 'darwin' ? path.normalize('NFC') : path;
	}

	protected override disposeCore(): void {
		for (const active of this.active.values()) for (const controller of active.values()) controller.abort();
		this.active.clear();
		this.fileDialogLocks.clear();
		super.disposeCore();
	}
}
