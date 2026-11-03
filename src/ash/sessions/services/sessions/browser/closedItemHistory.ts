import type { SessionsViewReference } from './visibleSessions.js';

type ClosedItem = {
	readonly reference: Extract<SessionsViewReference, { kind: 'session'; }>;
	readonly index: number;
	readonly replacedBy?: SessionsViewReference;
};

/** Holds the last closed or displaced durable slot for the lifetime of the window. */
export class ClosedItemHistory {
	private item: ClosedItem | undefined;

	get lastClosedItem(): ClosedItem | undefined {
		return this.item;
	}

	recordClosedItem(reference: ClosedItem['reference'], index: number, replacedBy?: SessionsViewReference): void {
		this.item = { reference, index, replacedBy };
	}

	clear(item: ClosedItem): void {
		if (this.item === item) {
			this.item = undefined;
		}
	}
}
