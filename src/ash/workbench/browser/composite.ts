import { trackFocus, type IFocusTracker } from '../../base/browser/focus.js';
import { Emitter } from '../../base/common/event.js';
import { toDisposable } from '../../base/common/lifecycle.js';
import type { IComposite, ICompositeControl } from '../common/composite.js';
import { Component } from '../common/component.js';
import type { IAction } from '../../base/common/actions.js';

/** Owns focus for the complete hosted content, across all of its child controls. */
export abstract class Composite<MementoType extends object = object> extends Component<MementoType> implements IComposite {
	public abstract readonly id: string;
	private readonly titleAreaUpdate = this._register(new Emitter<void>());
	public readonly onTitleAreaUpdate = this.titleAreaUpdate.event;
	private readonly focused = this._register(new Emitter<void>());
	private readonly blurred = this._register(new Emitter<void>());
	public readonly onDidFocus = this.focused.event;
	public readonly onDidBlur = this.blurred.event;
	private compositeContainer: HTMLElement | undefined;
	private compositeFocusTracker: IFocusTracker | undefined;

	/** Subclasses attach their own root before registering it here exactly once. */
	public create(parent: HTMLElement): void {
		if (this.compositeContainer) {
			throw new ReferenceError('Composite has already been created');
		}
		this.compositeContainer = parent;
		const tracker = this._register(trackFocus(parent));
		this.compositeFocusTracker = tracker;
		this._register(tracker.onDidFocus(() => this.focused.fire()));
		this._register(tracker.onDidBlur(() => this.blurred.fire()));
		this._register(toDisposable(() => {
			this.compositeFocusTracker = undefined;
			this.compositeContainer = undefined;
		}));
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
	public getSecondaryActions(): readonly IAction[] { return []; }
	public getContextMenuActions(): readonly IAction[] { return []; }

	protected updateTitleArea(): void {
		this.titleAreaUpdate.fire();
	}

	public hasFocus(): boolean {
		return this.compositeFocusTracker?.hasFocus === true;
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
}
