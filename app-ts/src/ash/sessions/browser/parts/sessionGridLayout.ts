import { Direction, Grid, Sizing, type IView } from '../../../base/browser/ui/grid/grid.js';
import { Disposable } from '../../../base/common/lifecycle.js';

export interface ISessionGridEntry {
	readonly id: string;
	readonly view: IView;
}

/** Owns split geometry; its caller owns membership, active identity, and view lifetimes. */
export class SessionGridLayout extends Disposable {
	public readonly element: HTMLDivElement;
	private readonly grid: Grid<IView>;
	private views: readonly IView[];

	constructor(container: HTMLElement, initialView: IView) {
		super();
		this.grid = this._register(new Grid<IView>(container, { type: 'leaf', view: initialView, size: 800 }, { sashPresentation: { type: 'inset', gap: 8 } }));
		this.element = this.grid.element;
		this.element.classList.add('ash-sessions-chat-grid');
		this.views = [initialView];
	}

	public reconcile(entries: readonly ISessionGridEntry[], active: string): void {
		const activeView = entries.find(entry => entry.id === active)?.view;
		const focused = this.element.ownerDocument.activeElement;
		const restoreFocus = focused instanceof this.element.ownerDocument.defaultView!.HTMLElement && activeView?.element.contains(focused);
		const nextViews = entries.map(entry => entry.view);
		const retained = new Set(nextViews);
		const current = [...this.views];
		// Insert before removing the last old leaf so a complete replacement stays in one live Grid.
		for (let index = 0; index < nextViews.length; index++) {
			const view = nextViews[index]!;
			const position = current.indexOf(view);
			if (position === index) {
				continue;
			}
			const reference = index === 0 ? current[0]! : nextViews[index - 1]!;
			const direction = index === 0 ? Direction.Left : Direction.Right;
			if (position < 0) {
				this.grid.addView(view, Sizing.Split, reference, direction);
			} else {
				const size = this.grid.getViewSize(view);
				this.grid.moveView(view, size.width, reference, direction);
				current.splice(position, 1);
			}
			current.splice(index, 0, view);
		}
		for (const view of this.views) {
			if (!retained.has(view)) {
				this.grid.removeView(view);
			}
		}
		this.views = nextViews;
		if (restoreFocus && focused.isConnected) {
			focused.focus({ preventScroll: true });
		}
	}

	public layout(width: number, height: number): void {
		this.grid.layout(width, height);
	}
}
