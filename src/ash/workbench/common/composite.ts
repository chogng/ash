import type { Event } from '../../base/common/event.js';

/** Workbench access to one hosted content unit; focus includes its descendants. */
export interface IComposite {
	readonly onDidFocus: Event<void>;
	readonly onDidBlur: Event<void>;
	hasFocus(): boolean;
	getId(): string;
	getTitle(): string | undefined;
	getControl(): ICompositeControl | undefined;
	focus(): void;
}

/** Control capabilities are defined by the content's owning interface. */
export interface ICompositeControl { }
