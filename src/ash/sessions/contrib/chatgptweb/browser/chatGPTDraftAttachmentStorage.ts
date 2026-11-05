import { IndexedDB } from '../../../../base/browser/indexedDB.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../base/common/types.js';
import { isUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { type IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { ChatGPTFile } from './chatGPTClient.js';

const fileStore = 'files';

export interface ChatGPTAttachment {
	readonly id: string;
	readonly name: string;
	readonly size: number;
	readonly status: 'uploading' | 'ready' | 'failed';
	readonly file?: ChatGPTFile;
	readonly error?: string;
}

/** The draft manifest owns file references. Binary payloads stay outside the workbench state file. */
export class ChatGPTDraftAttachmentStorage extends Disposable {
	private database: Promise<IndexedDB> | undefined;

	constructor(private readonly storage: IStorageService) {
		super();
		this._register(toDisposable(() => { void this.database?.then(db => db.close(), () => undefined); }));
	}

	read(localId: string): { scope: string; attachments: ChatGPTAttachment[]; } | undefined {
		const raw = this.storage.get(this.key(localId), StorageScope.WORKSPACE);
		if (!raw) { return undefined; }
		let value: unknown;
		try { value = JSON.parse(raw); } catch { return undefined; }
		if (!isRecord(value) || typeof value.scope !== 'string' || !/^[a-f0-9]{64}$/u.test(value.scope)
			|| !Array.isArray(value.attachments) || value.attachments.length > 10) { return undefined; }
		const attachments = value.attachments.flatMap<ChatGPTAttachment>(entry => {
			if (!isRecord(entry) || !isUuid(entry.id) || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 1024
				|| typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 20 * 1024 * 1024) { return []; }
			const base = { id: entry.id, name: entry.name, size: entry.size };
			const file = entry.file;
			if (entry.status === 'ready' && isRecord(file) && typeof file.id === 'string' && /^file[-_][A-Za-z0-9_-]{1,240}$/u.test(file.id)
				&& typeof file.mimeType === 'string' && file.mimeType.length <= 1024 && !/[\r\n\0]/u.test(file.mimeType)) {
				return [{
					...base, status: 'ready' as const, file: {
						...base, id: file.id, mimeType: file.mimeType,
						width: readDimension(file.width), height: readDimension(file.height),
					}
				}];
			}
			return [{ ...base, status: 'failed' as const, error: localize('sessions.chatgpt.retryRestoredAttachment', 'Retry to upload the restored attachment.') }];
		});
		if (new Set(attachments.map(attachment => attachment.id)).size !== attachments.length
			|| attachments.reduce((total, attachment) => total + attachment.size, 0) > 50 * 1024 * 1024) { return undefined; }
		return { scope: value.scope, attachments };
	}

	write(localId: string, scope: string, attachments: readonly ChatGPTAttachment[]): void {
		const entries = attachments.map(({ id, name, size, status, file }) => ({ id, name, size, status, file }));
		this.storage.store(this.key(localId), entries.length ? JSON.stringify({ scope, attachments: entries }) : undefined, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	has(localId: string): boolean {
		return this.storage.get(this.key(localId), StorageScope.WORKSPACE) !== undefined;
	}

	remove(localId: string): void {
		this.storage.remove(this.key(localId), StorageScope.WORKSPACE);
	}

	async saveFiles(scope: string, files: readonly { id: string; file: File; }[]): Promise<void> {
		const db = await this.open();
		await db.runInTransaction(fileStore, 'readwrite', store => files.map(({ id, file }) => store.put(file, [scope, id])));
	}

	async readFile(scope: string, attachment: ChatGPTAttachment): Promise<File | undefined> {
		const db = await this.open();
		const file: unknown = await db.runInTransaction(fileStore, 'readonly', store => store.get([scope, attachment.id]));
		return file instanceof File && file.name === attachment.name && file.size === attachment.size ? file : undefined;
	}

	async deleteFiles(scope: string, ids: readonly string[]): Promise<void> {
		if (!ids.length) { return; }
		const db = await this.open();
		await db.runInTransaction(fileStore, 'readwrite', store => ids.map(id => store.delete([scope, id])));
	}

	private key(localId: string): string { return `sessions.chatgpt.draftAttachments:${localId}`; }

	private open(): Promise<IndexedDB> {
		this.assertNotDisposed();
		return this.database ??= IndexedDB.create('ash-chatgpt-draft-attachments', 1, [fileStore]).catch(error => {
			this.database = undefined;
			throw error;
		});
	}
}

function readDimension(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
