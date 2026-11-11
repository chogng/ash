import './media/chatImageGenerationBatchPart.css';
import { h } from '../../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { IChatListItem } from '../../../common/model/chatViewModel.js';
import { ChatGeneratedImageResultSubPart, getGeneratedImageResultCount } from './toolInvocationParts/chatGeneratedImageResultSubPart.js';
import { ChatImageGenerationProgressPart } from './toolInvocationParts/chatImageGenerationProgressPart.js';
import { isImageGenerationToolInProgress } from './toolInvocationParts/chatToolPartUtilities.js';

/** Owns a contiguous image batch independently of the row currently displaying it. */
export class ChatImageGenerationBatchPart extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly animation = this._register(new MutableDisposable<ChatImageGenerationProgressPart>());
	private readonly results = this._register(new MutableDisposable<ChatGeneratedImageResultSubPart>());
	private readonly resultChanges = this._register(new MutableDisposable());
	private readonly changedHeight = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this.changedHeight.event;
	private visible = true;

	constructor(document: Document, @IInstantiationService private readonly instantiation: IInstantiationService) {
		super();
		this.domNode = h(document, 'div');
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public render(batch: readonly IChatListItem[]): void {
		const generated = getGeneratedImageResultCount(batch) > 0;
		const generating = batch.some(item => item.toolInvocation && isImageGenerationToolInProgress(item.toolInvocation));
		if (generating && !generated && !this.animation.value) {
			const animation = this.animation.value = this.instantiation.createInstance(ChatImageGenerationProgressPart, this.domNode.ownerDocument);
			this.domNode.append(animation.domNode);
			animation.setVisible(this.visible);
		}
		if (!generated) {
			this.resultChanges.clear();
			this.results.clear();
			if (!generating) {
				this.animation.clear();
			}
			return;
		}
		if (!this.results.value) {
			const animation = this.animation.value;
			const origin = animation && this.visible ? {
				container: animation.domNode, size: animation.size, takeSurface: () => animation.takeSurface(),
			} : undefined;
			if (!origin) {
				this.animation.clear();
			}
			const results = this.results.value = this.instantiation.createInstance(ChatGeneratedImageResultSubPart, this.domNode.ownerDocument, origin);
			this.domNode.append(results.domNode);
			this.resultChanges.value = results.onDidChangeHeight(() => {
				if (this.animation.value?.domNode.hidden) {
					this.animation.clear();
				}
				this.changedHeight.fire();
			});
			results.setVisible(this.visible);
		}
		this.results.value.render(batch);
		if (this.animation.value?.domNode.hidden) {
			this.animation.clear();
		}
	}

	public setVisible(show: boolean): void {
		this.visible = show;
		this.animation.value?.setVisible(show);
		this.results.value?.setVisible(show);
	}
}
