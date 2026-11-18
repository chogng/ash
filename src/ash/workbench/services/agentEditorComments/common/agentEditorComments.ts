import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IRange } from '../../../../editor/common/core/range.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export interface IAgentEditorComment {
	readonly id: string;
	readonly resource: URI;
	readonly range: IRange;
	readonly body: string;
}

export interface IAgentEditorCommentsProvider {
	readonly onDidChangeComments: Event<void>;
	getComments(): readonly IAgentEditorComment[];
	addComment(range: IRange, body: string): boolean;
	deleteComment(id: string): void;
}

export const IAgentEditorCommentsBridge = createServiceIdentifier<IAgentEditorCommentsBridge>('agentEditorCommentsBridge');

/** Routes editor actions to the owner of a live review document. */
export interface IAgentEditorCommentsBridge {
	readonly onDidChangeComments: Event<URI>;
	registerProvider(resource: URI, provider: IAgentEditorCommentsProvider): IDisposable;
	acceptsComments(resource: URI): boolean;
	getComments(resource: URI): readonly IAgentEditorComment[];
	addComment(resource: URI, range: IRange, body: string): boolean;
	deleteComment(resource: URI, id: string): void;
}

export class AgentEditorCommentsBridge extends Disposable implements IAgentEditorCommentsBridge {
	private readonly change = this._register(new Emitter<URI>());
	readonly onDidChangeComments = this.change.event;
	private readonly providers = new Map<string, { readonly provider: IAgentEditorCommentsProvider; readonly listener: IDisposable; }>();

	registerProvider(resource: URI, provider: IAgentEditorCommentsProvider): IDisposable {
		const key = resource.toString();
		if (this.providers.has(key)) throw new Error(`A comment provider is already registered for ${key}`);
		const entry = { provider, listener: provider.onDidChangeComments(() => this.change.fire(resource)) };
		this.providers.set(key, entry);
		this.change.fire(resource);
		return toDisposable(() => {
			if (this.providers.get(key) !== entry) return;
			this.providers.delete(key);
			entry.listener.dispose();
			this.change.fire(resource);
		});
	}

	acceptsComments(resource: URI): boolean {
		return this.providers.has(resource.toString());
	}

	getComments(resource: URI): readonly IAgentEditorComment[] {
		return this.providers.get(resource.toString())?.provider.getComments() ?? [];
	}

	addComment(resource: URI, range: IRange, body: string): boolean {
		return this.providers.get(resource.toString())?.provider.addComment(range, body) ?? false;
	}

	deleteComment(resource: URI, id: string): void {
		this.providers.get(resource.toString())?.provider.deleteComment(id);
	}

	override dispose(): void {
		for (const { listener } of this.providers.values()) listener.dispose();
		this.providers.clear();
		super.dispose();
	}
}
