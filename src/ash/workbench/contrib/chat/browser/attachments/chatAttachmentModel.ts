import { Emitter } from '../../../../../base/common/event.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';

export interface IChatAttachmentChangeEvent {
	readonly deleted: readonly string[];
	readonly added: readonly ChatContextAttachment[];
	readonly updated: readonly ChatContextAttachment[];
}

/** Owns the attachments of one composer, including identity during an in-flight submission. */
export class ChatAttachmentModel extends Disposable {
	private readonly entries = new Map<string, ChatContextAttachment>();
	private readonly pending = new Map<Promise<readonly ChatContextAttachment[]>, { readonly controller: AbortController; readonly editsMessage: boolean }>();
	private readonly changes = this._register(new Emitter<IChatAttachmentChangeEvent>());
	public readonly onDidChange = this.changes.event;
	private readonly preparationChanges = this._register(new Emitter<void>());
	/** Draft lifetimes must also observe unfinished acquisitions, without treating them as attached entries. */
	public readonly onDidChangePendingContext = this.preparationChanges.event;

	constructor() {
		super();
		this._register(
			toDisposable(() => {
				this.cancelPendingContext();
				this.entries.clear();
			}),
		);
	}

	public get hasPendingContext(): boolean {
		return this.pending.size > 0;
	}

	/** These acquisitions can insert message references, so submission must capture text after they finish. */
	public get hasPendingMessageContext(): boolean {
		return [...this.pending.values()].some(operation => operation.editsMessage);
	}

	/** Keeps preparation in the draft lifetime; a clear or disposal rejects waiters immediately. */
	public acquireContext(
		prepare: (signal: AbortSignal) => Promise<readonly ChatContextAttachment[]>,
		signal?: AbortSignal,
		accept?: (attachments: readonly ChatContextAttachment[], signal: AbortSignal) => readonly ChatContextAttachment[],
	): Promise<readonly ChatContextAttachment[]> {
		if (this.isDisposed || signal?.aborted) return Promise.reject(new CancellationError());
		const controller = new AbortController();
		const cancel = () => controller.abort();
		signal?.addEventListener('abort', cancel, { once: true });
		let cancelled!: () => void;
		const operation = new Promise<readonly ChatContextAttachment[]>((resolve, reject) => {
			cancelled = () => reject(new CancellationError());
			controller.signal.addEventListener('abort', cancelled, { once: true });
			void Promise.resolve()
				.then(() => {
					if (controller.signal.aborted) throw new CancellationError();
					return prepare(controller.signal);
				})
				.then(attachments => {
					if (controller.signal.aborted || this.isDisposed) return;
					const accepted = accept ? accept(attachments, controller.signal) : undefined;
					if (!accept) this.addContext(...attachments);
					if (controller.signal.aborted) return;
					resolve(accepted ?? attachments.map(attachment => this.entries.get(attachment.id) ?? attachment));
				})
				.catch(reject);
		});
		this.pending.set(operation, { controller, editsMessage: accept !== undefined });
		const settled = () => {
			controller.signal.removeEventListener('abort', cancelled);
			signal?.removeEventListener('abort', cancel);
			if (this.pending.delete(operation)) this.preparationChanges.fire();
		};
		// Observe both outcomes without replacing the promise that a submission awaits.
		void operation.then(settled, settled);
		this.preparationChanges.fire();
		return operation;
	}

	/** Captures only batches present at invocation; files added to a later draft stay outside this request. */
	public async resolvePendingContext(): Promise<readonly ChatContextAttachment[]> {
		const contexts = this.attachments;
		const prepared = await Promise.all(this.pending.keys());
		return [...new Map([...contexts, ...prepared.flat()].map(attachment => [attachment.id, attachment])).values()];
	}

	public cancelPendingContext(): void {
		if (this.pending.size === 0) return;
		for (const { controller } of this.pending.values()) controller.abort();
		this.pending.clear();
		this.preparationChanges.fire();
	}

	public get attachments(): readonly ChatContextAttachment[] {
		return [...this.entries.values()];
	}

	public get size(): number {
		return this.entries.size;
	}

	public getAttachmentIDs(): Set<string> {
		return new Set(this.entries.keys());
	}

	public addContext(...attachments: ChatContextAttachment[]): void {
		// Content-identical image IDs retain the original capture and preview name.
		const imageIds = this.getAttachmentIDs();
		this.updateContext(
			[],
			attachments.filter(attachment => {
				if (attachment.kind !== 'image') return true;
				if (imageIds.has(attachment.id)) return false;
				imageIds.add(attachment.id);
				return true;
			}),
		);
	}

	/** Replaces current identities atomically; undo snapshots remain owned by the reference history. */
	public clearAndSetContext(...attachments: ChatContextAttachment[]): void {
		this.updateContext(this.entries.keys(), attachments);
	}

	public delete(...ids: string[]): void {
		this.updateContext(ids, []);
	}

	public updateContext(toDelete: Iterable<string>, upsert: Iterable<ChatContextAttachment>): void {
		const next = new Map(this.entries);
		for (const id of toDelete) next.delete(id);
		for (const attachment of upsert) next.set(attachment.id, attachment);
		const deleted = [...this.entries.keys()].filter(id => !next.has(id));
		const added = [...next.values()].filter(attachment => !this.entries.has(attachment.id));
		const updated = [...next.values()].filter(attachment => this.entries.has(attachment.id) && this.entries.get(attachment.id) !== attachment);
		if (!deleted.length && !added.length && !updated.length) return;
		this.entries.clear();
		for (const [id, attachment] of next) this.entries.set(id, attachment);
		this.changes.fire({ deleted, added, updated });
	}

	public clear(): void {
		this.cancelPendingContext();
		if (this.entries.size === 0) {
			return;
		}
		this.clearAndSetContext();
	}
}
