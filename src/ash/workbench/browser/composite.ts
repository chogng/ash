import { trackFocus, type IFocusTracker } from '../../base/browser/focus.js';
import { Emitter } from '../../base/common/event.js';
import { toDisposable } from '../../base/common/lifecycle.js';
import type { IComposite, ICompositeControl } from '../common/composite.js';
import { Component } from '../common/component.js';
import type { IAction } from '../../base/common/actions.js';
import type { IDimension } from '../../base/browser/dom.js';
import type { ActionViewItem, ActionViewItemOptions } from '../../base/browser/ui/actionbar/actionViewItems.js';

/** Owns focus for the complete hosted content, across all of its child controls. */
export abstract class Composite<MementoType extends object = object> extends Component<MementoType> implements IComposite {
	private readonly constraintsChanged = this._register(new Emitter<void>());
	readonly onDidChangeConstraints = this.constraintsChanged.event;

	/** Hosted content reports its minimum; the outer Part adds its own chrome and frame. */
	get minimumWidth(): number { return 0; }

	protected notifyConstraintsChanged(): void {
		this.constraintsChanged.fire();
	}

	public abstract readonly id: string;
	private readonly titleAreaUpdate = this._register(new Emitter<void>());
	public readonly onTitleAreaUpdate = this.titleAreaUpdate.event;
	private readonly focused = this._register(new Emitter<void>());
	private readonly blurred = this._register(new Emitter<void>());
	public readonly onDidFocus = this.focused.event;
	public readonly onDidBlur = this.blurred.event;
	private compositeContainer: HTMLElement | undefined;
	private readonly compositeFocusTrackers: IFocusTracker[] = [];
	private compositeHasFocus = false;

	/** Subclasses attach their own root before registering it here exactly once. */
	public create(parent: HTMLElement): void {
		if (this.compositeContainer) {
			throw new ReferenceError('Composite has already been created');
		}
		this.compositeContainer = parent;
		this.trackCompositeFocus(parent);
		this._register(toDisposable(() => {
			this.compositeFocusTrackers.length = 0;
			this.compositeHasFocus = false;
			this.compositeContainer = undefined;
		}));
	}

	/** Additional roots participate in a single focus boundary with the content. */
	protected trackCompositeFocus(root: HTMLElement): void {
		const tracker = this._register(trackFocus(root));
		this.compositeFocusTrackers.push(tracker);
		this.compositeHasFocus ||= tracker.hasFocus;
		const update = () => {
			const focused = this.compositeFocusTrackers.some(tracker => tracker.hasFocus);
			if (focused === this.compositeHasFocus) return;
			this.compositeHasFocus = focused;
			if (focused) this.focused.fire();
			else this.blurred.fire();
		};
		this._register(tracker.onDidFocus(update));
		this._register(tracker.onDidBlur(update));
	}

	public getContainer(): HTMLElement | undefined {
		return this.compositeContainer;
	}

	public getTitle(): string | undefined {
		return undefined;
	}

	public getControl(): ICompositeControl | undefined {
		return undefined;
	}

	public getActions(): readonly IAction[] { return []; }
	public getActionViewItem(_action: IAction, _options: ActionViewItemOptions): ActionViewItem | undefined { return undefined; }
	public getSecondaryActions(): readonly IAction[] { return []; }
	public getContextMenuActions(): readonly IAction[] { return []; }

	protected updateTitleArea(): void {
		this.titleAreaUpdate.fire();
	}

	public hasFocus(): boolean {
		return this.compositeHasFocus;
	}

	public isVisible(): boolean {
		return this.compositeContainer !== undefined && !this.compositeContainer.hidden;
	}

	public setVisible(visible: boolean): void {
		if (this.compositeContainer) {
			this.compositeContainer.hidden = !visible;
		}
	}

	public abstract focus(): void;
	public abstract layout(dimension: IDimension): void;
}
