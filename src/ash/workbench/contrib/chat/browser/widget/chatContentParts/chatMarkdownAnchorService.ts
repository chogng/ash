import { addDisposableListener } from '../../../../../../base/browser/dom.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { InlineAnchorWidget } from './chatInlineAnchorWidget.js';

export const IChatMarkdownAnchorService = createDecorator<IChatMarkdownAnchorService>('chatMarkdownAnchorService');

export interface IChatMarkdownAnchorService {
	readonly _serviceBrand: undefined;
	readonly lastFocusedAnchor: InlineAnchorWidget | undefined;
	register(widget: InlineAnchorWidget): IDisposable;
}

/** Tracks file-anchor focus for commands invoked in this Workbench. */
export class ChatMarkdownAnchorService extends Disposable implements IChatMarkdownAnchorService {
	declare readonly _serviceBrand: undefined;
	private readonly registrations = this._register(new DisposableMap<InlineAnchorWidget, DisposableStore>());
	private focused: InlineAnchorWidget | undefined;

	get lastFocusedAnchor(): InlineAnchorWidget | undefined { return this.focused; }

	register(widget: InlineAnchorWidget): IDisposable {
		if (this.registrations.has(widget)) throw new Error('Chat file anchor is already registered');
		const lifetime = this.registrations.set(widget, new DisposableStore());
		const element = widget.element;
		const clear = () => { if (this.focused === widget) this.focused = undefined; };
		lifetime.add(addDisposableListener(element, 'focus', () => { this.focused = widget; }));
		lifetime.add(addDisposableListener(element, 'blur', clear));
		lifetime.add(toDisposable(clear));
		if (element.ownerDocument.activeElement === element) this.focused = widget;
		return toDisposable(() => this.registrations.deleteAndDispose(widget));
	}
}
