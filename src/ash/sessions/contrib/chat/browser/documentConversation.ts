import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, type IObservable } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../base/common/types.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../../platform/storage/common/storage.js';

export interface DocumentConversationReference {
	readonly kind: 'draft' | 'conversation';
	readonly id: string;
	readonly threadId?: string;
}

export interface DocumentConversationSelection {
	readonly scope: string;
	/** Stable across first-send materialization, distinct from navigation to another conversation. */
	readonly identity: string;
	readonly reference: DocumentConversationReference;
}

type Binding = DocumentConversationSelection;

export const documentConversationStorageKeys = {
	ash: 'sessions.ashChat.documentConversations',
	chatgpt: 'sessions.chatgpt.documentConversations',
	experimentalChatgpt: 'sessions.experimentalChatgpt.documentConversations',
} as const;

export function retireDocumentConversation(storage: IStorageService, resource: URI, replacement?: URI): void {
	const id = resource.toString();
	const target = replacement?.toString();
	if (target === id) return;
	for (const key of Object.values(documentConversationStorageKeys)) {
		const bindings = readBindings(storage, key);
		if (bindings[id]) {
			if (target && !bindings[target]) bindings[target] = bindings[id];
			delete bindings[id];
			if (Object.keys(bindings).length) storage.store(key, JSON.stringify(bindings), StorageScope.PROFILE, StorageTarget.MACHINE);
			else storage.remove(key, StorageScope.PROFILE);
		}
	}
}

/** Stores document associations only; the source retains conversations and unsent drafts. */
export class DocumentConversation extends Disposable {
	private previous: DocumentConversationSelection | undefined;

	constructor(
		private readonly key: string,
		private readonly selection: IObservable<DocumentConversationSelection | undefined>,
		private readonly select: (reference: DocumentConversationReference | undefined, signal: AbortSignal) => Promise<boolean>,
		private readonly storage: IStorageService,
	) {
		super();
		this._register(autorun(reader => {
			const current = selection.read(reader);
			const previous = this.previous;
			this.previous = current;
			if (!current || !previous || current.scope !== previous.scope || current.identity !== previous.identity
				|| JSON.stringify(current.reference) === JSON.stringify(previous.reference)) return;
			const bindings = this.read();
			for (const [resource, binding] of Object.entries(bindings)) {
				if (binding.scope === previous.scope && binding.identity === previous.identity) bindings[resource] = current;
			}
			this.save(bindings);
		}));
	}

	public async open(resource: URI, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (this.isDisposed) throw new CancellationError();
		const scope = this.selection.get()?.scope;
		if (!scope) throw new CancellationError();
		const key = resource.toString();
		const saved = this.read()[key];
		const reference = saved && saved.scope === scope ? saved.reference : undefined;
		if (!await this.select(reference, signal)) {
			signal.throwIfAborted();
			if (!reference || !await this.select(undefined, signal)) throw new CancellationError();
		}
		signal.throwIfAborted();
		const current = this.selection.get();
		if (this.isDisposed || !current || current.scope !== scope) throw new CancellationError();
		this.save({ ...this.read(), [key]: current });
	}

	private read(): Record<string, Binding> { return readBindings(this.storage, this.key); }

	private save(bindings: Record<string, Binding>): void {
		this.storage.store(this.key, JSON.stringify(bindings), StorageScope.PROFILE, StorageTarget.MACHINE);
	}
}

function readBindings(storage: IStorageService, key: string): Record<string, Binding> {
	const result: Record<string, Binding> = Object.create(null);
	const raw = storage.get(key, StorageScope.PROFILE);
	if (!raw) return result;
	let value: unknown;
	try { value = JSON.parse(raw); } catch { return result; }
	if (!isRecord(value)) return result;
	for (const [resource, binding] of Object.entries(value)) {
		if (!isRecord(binding) || typeof binding.scope !== 'string' || !binding.scope
			|| typeof binding.identity !== 'string' || !binding.identity || !isRecord(binding.reference)) continue;
		const ref = binding.reference;
		if ((ref.kind !== 'draft' && ref.kind !== 'conversation') || typeof ref.id !== 'string' || !ref.id
			|| (ref.threadId !== undefined && typeof ref.threadId !== 'string')) continue;
		result[resource] = { scope: binding.scope, identity: binding.identity, reference: { kind: ref.kind, id: ref.id, threadId: ref.threadId } };
	}
	return result;
}
