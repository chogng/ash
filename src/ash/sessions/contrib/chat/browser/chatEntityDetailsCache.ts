import { IndexedDB } from '../../../../base/browser/indexedDB.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../base/common/types.js';
import type { ChatMarkdownRichPart } from '../../../../workbench/contrib/chat/common/model/chatMarkdownRichContent.js';
import type { IChatListItem } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';

export type ChatEntityDetailsReply = Pick<IChatListItem, 'id' | 'text' | 'markdown' | 'resources'>;

const replies = 'replies';
const resources = 'resources';
const replyLimit = 2 * 1024 * 1024;
const resourceLimit = 16 * 1024 * 1024;

/** Completed Ash detail replies and their read-through resource cache live in the local profile. */
export class ChatEntityDetailsCache extends Disposable {
	private database: Promise<IndexedDB> | undefined;

	constructor() {
		super();
		this._register(toDisposable(() => { void this.database?.then(db => db.close(), () => undefined); }));
	}

	async read(key: string): Promise<readonly ChatEntityDetailsReply[] | undefined> {
		try {
			const db = await this.open();
			const value: unknown = await db.runInTransaction(replies, 'readonly', store => store.get(key));
			if (typeof value !== 'string' || value.length > replyLimit) return undefined;
			const parsed: unknown = JSON.parse(value);
			return Array.isArray(parsed) && parsed.length > 0 && parsed.every(isReply)
				? parsed.map(({ id, text, markdown, resources }) => ({ id, text, markdown, resources })) : undefined;
		} catch { return undefined; }
	}

	async write(key: string, items: readonly ChatEntityDetailsReply[]): Promise<void> {
		try {
			const value = JSON.stringify(items);
			if (value.length > replyLimit) return;
			const db = await this.open();
			await db.runInTransaction(replies, 'readwrite', store => store.put(value, key));
		} catch { /* Storage failures leave the current reply readable. */ }
	}

	async readResource(key: string, itemId: string, uri: string): Promise<Blob | undefined> {
		try {
			const db = await this.open();
			const value: unknown = await db.runInTransaction(resources, 'readonly', store => store.get([key, itemId, uri]));
			return value instanceof Blob && value.size <= resourceLimit ? value : undefined;
		} catch { return undefined; }
	}

	async writeResource(key: string, itemId: string, uri: string, blob: Blob): Promise<void> {
		if (!blob.size || blob.size > resourceLimit) return;
		try {
			const db = await this.open();
			await db.runInTransaction(resources, 'readwrite', store => store.put(blob, [key, itemId, uri]));
		} catch { /* A successful resource read still renders when storage is unavailable. */ }
	}

	private open(): Promise<IndexedDB> {
		this.assertNotDisposed();
		return this.database ??= IndexedDB.create('ash-chat-entity-details', 1, [replies, resources]).catch(error => {
			this.database = undefined;
			throw error;
		});
	}
}

function isReply(value: unknown): value is ChatEntityDetailsReply {
	if (!isRecord(value) || typeof value.id !== 'string' || typeof value.text !== 'string') return false;
	const { markdown, resources } = value;
	if (resources !== undefined && (!Array.isArray(resources) || !resources.every(resource => isRecord(resource)
		&& typeof resource.uri === 'string' && typeof resource.name === 'string'
		&& typeof resource.kind === 'string' && ['image', 'audio', 'video', 'document', 'html', 'chart'].includes(resource.kind)
		&& (resource.mimeType === undefined || typeof resource.mimeType === 'string')
		&& (resource.frameOrigin === undefined || typeof resource.frameOrigin === 'string')))) return false;
	if (markdown === undefined) return true;
	if (!isRecord(markdown) || typeof markdown.supportHtml !== 'boolean'
		|| (markdown.linkPolicy !== undefined && markdown.linkPolicy !== 'external')) return false;
	const rich = markdown.richContent;
	return rich === undefined || isRecord(rich) && typeof rich.markerPrefix === 'string'
		&& Array.isArray(rich.parts) && rich.parts.every(isRichPart);
}

function isLink(value: unknown): boolean {
	return isRecord(value) && typeof value.label === 'string' && typeof value.href === 'string';
}

function isStyle(value: unknown): boolean {
	return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string');
}

function isRichPart(value: unknown): value is ChatMarkdownRichPart {
	if (!isRecord(value) || typeof value.block !== 'boolean') return false;
	switch (value.kind) {
		case 'markdown': case 'gridItem': return typeof value.markdown === 'string';
		case 'grid': return typeof value.markdown === 'string' && typeof value.columns === 'number'
			&& [1, 2, 3, 4].includes(value.columns) && isStyle(value.style);
		case 'box': case 'row': case 'text':
			return typeof value.markdown === 'string' && isStyle(value.style) && (value.fallback === undefined || isLink(value.fallback));
		case 'icon': return typeof value.name === 'string' && typeof value.label === 'string' && isStyle(value.style) && isLink(value.fallback);
		case 'details': return typeof value.label === 'string' && typeof value.data === 'string' && typeof value.markdown === 'string';
		case 'citations': return Array.isArray(value.entries) && value.entries.every(entry => isRecord(entry) && typeof entry.number === 'number'
			&& typeof entry.title === 'string' && typeof entry.url === 'string' && typeof entry.snippet === 'string');
		case 'textLiteral': return typeof value.label === 'string';
		case 'entity': return isRecord(value.entity) && typeof value.entity.label === 'string'
			&& typeof value.entity.category === 'string' && typeof value.entity.disambiguation === 'string';
		case 'imageGallery': return (value.compact === undefined || typeof value.compact === 'boolean') && Array.isArray(value.images) && value.images.every(image => isRecord(image) && typeof image.uri === 'string'
			&& typeof image.label === 'string' && (image.source === undefined || typeof image.source === 'string'));
		case 'link': return value.block === false && isLink(value.link) && (value.title === undefined || typeof value.title === 'string');
		case 'resource': return typeof value.markdown === 'string' && typeof value.label === 'string'
			&& (value.uri === undefined || typeof value.uri === 'string') && (value.title === undefined || typeof value.title === 'string')
			&& (value.data === undefined || typeof value.data === 'string');
		case 'unavailableMedia': return isLink(value.fallback);
		default: return false;
	}
}
