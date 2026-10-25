import { h } from '../../../../../../../base/browser/dom.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../../../../nls.js';
import { GlyphSurface } from '../../../attachments/chatImageGlyphSurface.js';
import '../media/chatImageGenerationProgressPart.css';

/** Visual progress only: the backend tool result remains the authority for success and cancellation. */
export class ChatImageGenerationProgressPart extends Disposable {
	readonly domNode: HTMLElement;
	private readonly surface = this._register(new MutableDisposable<GlyphSurface>());

	constructor(document: Document, @IInstantiationService instantiation: IInstantiationService) {
		super();
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-chat-image-generation-placeholder';
		this.domNode.setAttribute('role', 'img');
		this.domNode.setAttribute('aria-label', localize('chat.imageGeneration.placeholder', 'Generating image'));
		this.domNode.setAttribute('aria-busy', 'true');
		this.surface.value = instantiation.createInstance(GlyphSurface, this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
	}

	get size(): number | undefined { return this.domNode.getBoundingClientRect().width || undefined; }
	takeSurface(): GlyphSurface | undefined { return this.surface.clearAndLeak(); }
	setVisible(visible: boolean): void { this.surface.value?.setVisible(visible); }
}
