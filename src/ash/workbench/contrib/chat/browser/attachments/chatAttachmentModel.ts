import { Emitter } from '../../../../../base/common/event.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';

/** Owns the attachments of one composer, including identity during an in-flight submission. */
export class ChatAttachmentModel extends Disposable {
	private readonly entries = new Map<string, ChatContextAttachment>();
	private readonly pending = new Map<Promise<readonly ChatContextAttachment[]>, { readonly controller: AbortController; readonly editsMessage: boolean; }>();
	private readonly changes = this._register(new Emitter<void>());
	public readonly onDidChange = this.changes.event;
	private readonly preparationChanges = this._register(new Emitter<void>());
	/** Draft lifetimes must also observe unfinished acquisitions, without treating them as attached entries. */
	public readonly onDidChangePendingContext = this.preparationChanges.event;

	constructor() {
		super();
		this._register(toDisposable(() => this.cancelPendingContext()));
	}

	public get hasPendingContext(): boolean {
		return this.pending.size > 0;
	}

	/** These acquisitions can insert message references, so submission must capture text after they finish. */
	public get hasPendingMessageContext(): boolean {
		return [...this.pending.values()].some(operation => operation.editsMessage);
	}

	/** Keeps preparation in the draft lifetime; a clear or disposal rejects waiters immediately. */
	public acquireContext(prepare: (signal: AbortSignal) => Promise<readonly ChatContextAttachment[]>, signal?: AbortSignal, accept?: (attachments: readonly ChatContextAttachment[], signal: AbortSignal) => readonly ChatContextAttachment[]): Promise<readonly ChatContextAttachment[]> {
		if (this.isDisposed || signal?.aborted) return Promise.reject(new CancellationError());
		const controller = new AbortController();
		const cancel = () => controller.abort();
		signal?.addEventListener('abort', cancel, { once: true });
		let cancelled!: () => void;
		const operation = new Promise<readonly ChatContextAttachment[]>((resolve, reject) => {
			cancelled = () => reject(new CancellationError());
			controller.signal.addEventListener('abort', cancelled, { once: true });
			void Promise.resolve().then(() => {
				if (controller.signal.aborted) throw new CancellationError();
				return prepare(controller.signal);
			}).then(attachments => {
				if (controller.signal.aborted || this.isDisposed) return;
				const accepted = accept ? accept(attachments, controller.signal) : undefined;
				if (!accept) this.addContext(...attachments);
				if (controller.signal.aborted) return;
				resolve(accepted ?? attachments.map(attachment => this.entries.get(attachment.id) ?? attachment));
			}).catch(reject);
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

	public addContext(...attachments: ChatContextAttachment[]): void {
		if (attachments.length === 0) return;
		for (const attachment of attachments) {
			// Identical image bytes share one entry, including the original preview name and in-flight identity.
			if (attachment.kind !== 'image' || !this.entries.has(attachment.id)) this.entries.set(attachment.id, attachment);
		}
		this.changes.fire();
	}

	public delete(...ids: string[]): void {
		let changed = false;
		for (const id of ids) {
			changed = this.entries.delete(id) || changed;
		}
		if (changed) {
			this.changes.fire();
		}
	}

	public clear(): void {
		this.cancelPendingContext();
		if (this.entries.size === 0) {
			return;
		}
		this.entries.clear();
		this.changes.fire();
	}
}
