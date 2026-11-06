import { isRecord } from '../../base/common/types.js';
import { type IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import type { ChatReplyMessage } from '../common/chatReplyBackend.js';

export interface ChatTimelineTask {
	readonly sessionId: string;
	readonly threadId: string;
	readonly afterMessageId?: string;
	readonly prompt: string;
	readonly error?: string;
}

export interface ChatTimeline {
	readonly localId: string;
	readonly tasks: readonly ChatTimelineTask[];
	readonly title?: string;
	readonly pinned?: boolean;
	readonly archived?: boolean;
	readonly history?: { readonly title: string; readonly parentId: string; readonly olderCursor?: string; readonly messages: readonly ChatReplyMessage[]; };
}

function isMessage(value: unknown): value is ChatReplyMessage {
	return isRecord(value) && typeof value.id === 'string' && (value.role === 'user' || value.role === 'assistant')
		&& typeof value.text === 'string'
		&& (value.references === undefined || Array.isArray(value.references) && value.references.every(item => isRecord(item)
			&& typeof item.id === 'string' && typeof item.url === 'string' && typeof item.title === 'string' && typeof item.snippet === 'string'))
		&& (value.resources === undefined || Array.isArray(value.resources) && value.resources.every(item => isRecord(item)
			&& typeof item.uri === 'string' && typeof item.name === 'string' && ['image', 'audio', 'video', 'document', 'html'].includes(String(item.kind))
			&& (item.mimeType === undefined || typeof item.mimeType === 'string') && (item.frameOrigin === undefined || typeof item.frameOrigin === 'string')))
		&& (value.activity === undefined || isRecord(value.activity) && ['call', 'result', 'progress'].includes(String(value.activity.kind))
			&& typeof value.activity.failed === 'boolean' && (value.activity.tool === undefined || typeof value.activity.tool === 'string'));
}

function isTask(value: unknown): value is ChatTimelineTask {
	return isRecord(value) && typeof value.sessionId === 'string' && typeof value.threadId === 'string'
		&& typeof value.prompt === 'string' && (value.error === undefined || typeof value.error === 'string') && (value.afterMessageId === undefined || typeof value.afterMessageId === 'string');
}

/** Stores Chat's backend snapshot and execution references separately from the Cowork transcript. */
export class ChatTimelineStorage {
	constructor(private readonly storage: IStorageService, private readonly backend: string) { }

	read(remoteId: string): ChatTimeline | undefined {
		const raw = this.storage.get(this.key(remoteId), StorageScope.PROFILE);
		if (!raw) return undefined;
		try {
			const value: unknown = JSON.parse(raw);
			if (!isRecord(value) || typeof value.localId !== 'string' || !Array.isArray(value.tasks) || !value.tasks.every(isTask)) return undefined;
			const metadata = {
				localId: value.localId, tasks: value.tasks,
				title: typeof value.title === 'string' ? value.title : undefined,
				pinned: value.pinned === true,
				archived: value.archived === true,
			};
			const history = value.history;
			if (isRecord(history) && typeof history.title === 'string' && typeof history.parentId === 'string'
				&& Array.isArray(history.messages) && history.messages.every(isMessage)) {
				const olderCursor = typeof history.olderCursor === 'string' && history.olderCursor.length <= 2048 ? history.olderCursor : undefined;
				return { ...metadata, history: { title: history.title, parentId: history.parentId, messages: history.messages, ...(olderCursor ? { olderCursor } : {}) } };
			}
			return metadata;
		} catch { return undefined; }
	}

	write(remoteId: string, timeline: ChatTimeline): void {
		this.storage.store(this.key(remoteId), JSON.stringify(timeline), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	remove(remoteId: string): void {
		this.storage.remove(this.key(remoteId), StorageScope.PROFILE);
	}

	listLocal(): readonly { id: string; timeline: ChatTimeline; }[] {
		const prefix = this.key('');
		return this.storage.keys(StorageScope.PROFILE, StorageTarget.MACHINE)
			.filter(key => key.startsWith(`${prefix}local:`))
			.flatMap(key => {
				const id = key.slice(prefix.length);
				const timeline = this.read(id);
				return timeline && !timeline.archived ? [{ id, timeline }] : [];
			});
	}

	private key(remoteId: string): string { return `sessions.chat.timeline.v1:${this.backend}:${remoteId}`; }
}
