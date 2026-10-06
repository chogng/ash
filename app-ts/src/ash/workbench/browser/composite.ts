import { trackFocus, type IFocusTracker } from '../../base/browser/focus.js';
import { Emitter } from '../../base/common/event.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import type { IComposite, ICompositeControl } from '../common/composite.js';

/** Owns focus for the complete hosted content, across all of its child controls. */
export abstract class Composite extends Disposable implements IComposite {
	public abstract readonly id: string;
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

	public getId(): string {
		return this.id;
	}

	public getTitle(): string | undefined {
		return undefined;
	}

	public getControl(): ICompositeControl | undefined {
		return undefined;
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
