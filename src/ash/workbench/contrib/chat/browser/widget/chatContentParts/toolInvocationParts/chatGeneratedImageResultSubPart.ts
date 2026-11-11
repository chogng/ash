import { h } from '../../../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import type { ChatContentPart } from '../../../../../../../platform/agentHost/common/agent.js';
import { localize } from '../../../../../../../nls.js';
import type { IChatImageRevealOrigin } from '../../../attachments/chatImageReveal.js';
import type { IChatListItem } from '../../../../common/model/chatViewModel.js';
import { ChatAttachmentsContentPart } from '../chatAttachmentsContentPart.js';
import { isImageGenerationToolInvocation } from './chatToolPartUtilities.js';

/** Each result retains its own persisted coordinates even when several calls share a gallery. */
export function getGeneratedImageResultSnapshot(content: readonly IChatListItem[]): { readonly item: IChatListItem; readonly content: readonly ChatContentPart[]; }[] {
	return content.flatMap(item => {
		const invocation = item.toolInvocation;
		const result = invocation?.result;
		if (!invocation || !isImageGenerationToolInvocation(invocation) || !result || result.isError || !result.content?.some(part => part.type === 'imageUrl' || part.type === 'imageAttachment')) {
			return [];
		}
		return [{ item, content: result.content }];
	});
}

export function getGeneratedImageResultCount(content: readonly IChatListItem[]): number {
	return getGeneratedImageResultSnapshot(content).reduce((count, result) => count + result.content.filter(part => part.type === 'imageUrl' || part.type === 'imageAttachment').length, 0);
}

/** Combines successful image results while the shared media owner retains reads, previews and URLs. */
export class ChatGeneratedImageResultSubPart extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly media = this._register(new DisposableMap<string, DisposableStore & { readonly part: ChatAttachmentsContentPart; }>());
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this.changed.event;
	private visible = true;
	private imageReveal: IChatImageRevealOrigin | undefined;

	constructor(document: Document, imageReveal: IChatImageRevealOrigin | undefined,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this.imageReveal = imageReveal;
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-chat-generated-image-result';
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public render(content: readonly IChatListItem[]): void {
		this.domNode.setAttribute('aria-label', localize('chat.imageGeneration.results', 'Generated images ({0})', getGeneratedImageResultCount(content)));
		const results = getGeneratedImageResultSnapshot(content).map(result => ({
			...result, id: JSON.stringify([result.item.attachmentSource, result.item.toolInvocation!.call.turnId, result.item.toolInvocation!.result!.itemId]),
		}));
		const ids = new Set(results.map(result => result.id));
		let changed = false;
		// Remove obsolete entries before ordering survivors; moving a focused survivor would blur it.
		for (const id of this.media.keys()) {
			if (!ids.has(id)) {
				this.media.deleteAndDispose(id);
				changed = true;
			}
		}
		let next = this.domNode.firstChild;
		for (const result of results) {
			const id = result.id;
			let entry = this.media.get(id);
			if (!entry) {
				const part = this.instantiation.createInstance(ChatAttachmentsContentPart, {
					ownerDocument: this.domNode.ownerDocument, variables: [], source: result.item.attachmentSource,
					imagePresentation: 'inline', imageReveal: this.imageReveal,
				});
				this.imageReveal = undefined;
				entry = this.media.set(id, Object.assign(new DisposableStore(), { part }));
				entry.add(part);
				entry.add(part.onDidChangeHeight(() => this.changed.fire()));
				part.setVisible(this.visible);
			}
			// Keep content indices unchanged so persisted media reads address the original result.
			entry.part.updateVariables(result.content.map(part => part.type === 'imageUrl' || part.type === 'imageAttachment' ? part : { type: 'text', text: '' }), result.item.attachmentSource);
			if (entry.part.domNode !== next) {
				this.domNode.insertBefore(entry.part.domNode, next);
				changed = true;
			}
			next = entry.part.domNode.nextSibling;
		}
		if (changed) {
			this.changed.fire();
		}
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		for (const [, entry] of this.media) {
			entry.part.setVisible(visible);
		}
	}
}
