import { Disposable } from '../../../../base/common/lifecycle.js';
import { constObservable, type IObservable } from '../../../../base/common/observable.js';
import type { MenuId } from '../../../../platform/actions/common/actions.js';
import type { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';

export interface ICustomViewDescriptor {
	readonly id: string;
	readonly ctor: SyncDescriptor<AbstractCustomView>;
	/** Restores the workspace beneath this page without dismissing the Custom View. */
	readonly entryCommand?: string;
	readonly actions?: { readonly menuId: MenuId; readonly primaryActionId?: string };
}

/** The host owns chrome and scrolling; contributed views own only their content and lifetime. */
export abstract class AbstractCustomView extends Disposable {
	abstract readonly title: IObservable<string>;
	readonly description: IObservable<string | undefined> = constObservable(undefined);
	readonly maxWidth: number | undefined = undefined;

	abstract render(container: HTMLElement): void;

	abstract layout(width: number, height: number): void;

	focus(): void {}
}
