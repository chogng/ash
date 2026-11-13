import { URI } from '../../../../base/common/uri.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { parseAuxiliaryWindowState, type AuxiliaryWindowOpenOptions } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { readChatWindowState, type IStoredChatWindow } from '../common/chatWindowState.js';
import type { IChatWindow, IChatWindowOpenOptions } from './chatWindow.js';

const storageKey = 'sessions.chatWindow.openChats';

export class ChatWindowsRestoration {
	private pending: readonly IStoredChatWindow[];
	private restoring: Promise<void> | undefined;

	constructor(@IStorageService private readonly storage: IStorageService) {
		this.pending = readChatWindowState(storage.get(storageKey, StorageScope.WORKSPACE));
	}

	get hasPendingWindows(): boolean { return this.pending.length > 0; }

	save(windows: readonly IStoredChatWindow[]): void {
		this.storage.store(storageKey, JSON.stringify({ version: 1, windows: [...windows, ...this.pending] }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	async restore<TWindow extends IChatWindow>(
		prepare: (chat: URI) => Promise<void>,
		open: (chat: URI, options: IChatWindowOpenOptions) => Promise<TWindow | undefined>,
		restoreLayout: (window: TWindow, state: IStoredChatWindow) => Promise<void>,
		openEditorWindow: (state: IStoredChatWindow, bounds: AuxiliaryWindowOpenOptions | undefined) => Promise<void>,
		onError: (error: unknown) => void,
	): Promise<void> {
		this.restoring ??= this.restorePending(prepare, open, restoreLayout, openEditorWindow, onError);
		await this.restoring;
	}

	private async restorePending<TWindow extends IChatWindow>(
		prepare: (chat: URI) => Promise<void>,
		open: (chat: URI, options: IChatWindowOpenOptions) => Promise<TWindow | undefined>,
		restoreLayout: (window: TWindow, state: IStoredChatWindow) => Promise<void>,
		openEditorWindow: (state: IStoredChatWindow, bounds: AuxiliaryWindowOpenOptions | undefined) => Promise<void>,
		onError: (error: unknown) => void,
	): Promise<void> {
		const saved = this.pending;
		const remaining = new Set(saved);
		for (const entry of saved) {
			try {
				const bounds = parseAuxiliaryWindowState(JSON.stringify(entry.bounds));
				if (entry.active === undefined) {
					await openEditorWindow(entry, bounds);
				} else {
					let window: TWindow | undefined;
					for (const value of entry.chats) {
						const chat = URI.parse(value, true);
						await prepare(chat);
						window = await open(chat, { window, preserveFocus: true, bounds }) ?? window;
					}
					if (window) {
						await restoreLayout(window, entry);
						await open(URI.parse(entry.active, true), { window, preserveFocus: true });
					}
				}
				remaining.delete(entry);
			} catch (error) {
				onError(error);
			}
			this.pending = [...remaining];
		}
	}
}
