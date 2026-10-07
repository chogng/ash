import type { Event } from '../common/event.js';

export interface IHistoryNavigationWidget {
	readonly element: HTMLElement;
	readonly onDidFocus: Event<void>;
	readonly onDidBlur: Event<void>;

	showPreviousValue(): void;
	showNextValue(): void;
}
