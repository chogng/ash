import { Emitter, type Event } from "../../../../base/common/event.js";
import type { Icon } from "../../../../base/common/icon.js";
import { Disposable, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

/** The side of the status bar that owns an entry. */
export enum StatusbarAlignment {
	Left = "left",
	Right = "right",
}

/** Semantic presentation applied to a status bar entry. */
export type StatusbarEntryKind = "standard" | "remote";

/** One icon-and-text segment rendered inside a grouped status bar entry. */
export interface IStatusbarEntrySegment {
	readonly icon?: Icon;
	readonly text: string;
}

/** Declarative content displayed by one status bar entry. */
export interface IStatusbarEntry {
	readonly icon?: Icon;
	readonly text: string;
	readonly segments?: readonly IStatusbarEntrySegment[];
	readonly kind?: StatusbarEntryKind;
	readonly ariaLabel?: string;
	readonly tooltip?: string;
	/** Optional activation hook for entries that expose a status action. */
	readonly run?: () => unknown;
}

/** Stable placement metadata supplied when an entry is registered. */
export interface IStatusbarEntryOptions {
	readonly id: string;
	readonly alignment: StatusbarAlignment;
	readonly priority?: number;
	/** Adjacent entries with the same key render as one compact visual group. */
	readonly compactGroup?: string;
}

/** A registered entry exposed to status bar views. */
export interface IStatusbarEntryItem {
	readonly id: string;
	readonly alignment: StatusbarAlignment;
	readonly priority: number;
	readonly compactGroup?: string;
	readonly entry: IStatusbarEntry;
}

/** Controls the lifetime and current content of one registered entry. */
export interface IStatusbarEntryAccessor extends IDisposable {
	update(entry: IStatusbarEntry): void;
}

/**
 * Owns the entries displayed by the status bar in one workbench window.
 *
 * Higher-priority entries appear closer to the outer edge of their alignment.
 */
export interface IStatusbarService {
	readonly onDidChangeEntries: Event<void>;

	addEntry(
		entry: IStatusbarEntry,
		options: IStatusbarEntryOptions,
	): IStatusbarEntryAccessor;

	getEntries(
		alignment: StatusbarAlignment,
	): readonly IStatusbarEntryItem[];
}

export const IStatusbarService =
	createServiceIdentifier<IStatusbarService>("statusbarService");

interface IStoredStatusbarEntry extends IStatusbarEntryItem {
	readonly order: number;
}

/** Default window-scoped status bar entry service. */
export class StatusbarService extends Disposable
	implements IStatusbarService {
	private readonly _onDidChangeEntries = this._register(new Emitter<void>());
	private readonly entries = new Map<string, IStoredStatusbarEntry>();
	private nextOrder = 0;

	readonly onDidChangeEntries = this._onDidChangeEntries.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.entries.clear();
		}));
	}

	addEntry(
		entry: IStatusbarEntry,
		options: IStatusbarEntryOptions,
	): IStatusbarEntryAccessor {
		if (this.isDisposed) {
			throw new ReferenceError("StatusbarService is already disposed");
		}
		if (!options.id) {
			throw new Error("A status bar entry requires a non-empty id");
		}
		if (this.entries.has(options.id)) {
			throw new Error(`Status bar entry already exists: ${options.id}`);
		}

		const priority = options.priority ?? 0;
		if (!Number.isFinite(priority)) {
			throw new Error("Status bar entry priority must be finite");
		}

		let stored: IStoredStatusbarEntry = {
			id: options.id,
			alignment: options.alignment,
			priority,
			compactGroup: options.compactGroup,
			entry: { ...entry },
			order: this.nextOrder++,
		};
		this.entries.set(stored.id, stored);
		this._onDidChangeEntries.fire();

		return new StatusbarEntryAccessor(
			(nextEntry) => {
				if (this.isDisposed || this.entries.get(stored.id) !== stored) return;
				stored = {
					...stored,
					entry: { ...nextEntry },
				};
				this.entries.set(stored.id, stored);
				this._onDidChangeEntries.fire();
			},
			() => {
				if (this.isDisposed || this.entries.get(stored.id) !== stored) return;
				this.entries.delete(stored.id);
				this._onDidChangeEntries.fire();
			},
		);
	}

	getEntries(
		alignment: StatusbarAlignment,
	): readonly IStatusbarEntryItem[] {
		return [...this.entries.values()]
			.filter((item) => item.alignment === alignment)
			.sort(compareEntries)
			.map(({ id, entry, priority, compactGroup, alignment: itemAlignment }) => ({
				id,
				entry,
				priority,
				compactGroup,
				alignment: itemAlignment,
			}));
	}
}

class StatusbarEntryAccessor extends Disposable
	implements IStatusbarEntryAccessor {
	private readonly _update: (entry: IStatusbarEntry) => void;
	private active = true;

	constructor(
		update: (entry: IStatusbarEntry) => void,
		remove: () => void,
	) {
		super();
		this._update = update;
		this._register(toDisposable(() => {
			this.active = false;
			remove();
		}));
	}

	update(entry: IStatusbarEntry): void {
		if (!this.active) return;
		this._update(entry);
	}
}

function compareEntries(
	first: IStoredStatusbarEntry,
	second: IStoredStatusbarEntry,
): number {
	return second.priority - first.priority || first.order - second.order;
}
