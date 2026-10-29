import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import type { IChatWidget, IChatWidgetService } from '../chat.js';
import { Emitter } from '../../../../../base/common/event.js';

/** Window-scoped input targeting. Models and media remain owned by each registered widget. */
export class ChatWidgetService extends Disposable implements IChatWidgetService {
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeWidgets = this.changed.event;
	private readonly widgets = new Map<IChatWidget, DisposableStore>();
	private focused: IChatWidget | undefined;

	get lastFocusedWidget(): IChatWidget | undefined {
		return this.focused?.visible ? this.focused : undefined;
	}

	getAllWidgets(): readonly IChatWidget[] {
		return [...this.widgets.keys()];
	}

	register(widget: IChatWidget): IDisposable {
		if (this.widgets.has(widget)) throw new Error('Chat widget is already registered');
		const lifetime = this._register(new DisposableStore());
		this.widgets.set(widget, lifetime);
		lifetime.add(widget.onDidChangeVisibility(() => this.changed.fire()));
		lifetime.add(widget.onDidChangeViewModel(() => this.changed.fire()));
		lifetime.add(
			addDisposableListener(widget.domNode, 'focusin', () => {
				if (widget.visible) this.focused = widget;
			}),
		);
		if (widget.visible && widget.domNode.contains(widget.domNode.ownerDocument.activeElement)) this.focused = widget;
		this.changed.fire();
		return toDisposable(() => {
			if (this.focused === widget) this.focused = undefined;
			this.widgets.delete(widget);
			this.changed.fire();
			this._store.delete(lifetime);
			lifetime.dispose();
		});
	}

	protected override disposeCore(): void {
		this.focused = undefined;
		this.widgets.clear();
		super.disposeCore();
	}
}
