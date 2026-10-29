import type { ColorIdentifier } from '../../../../platform/theme/common/colorRegistry.js';
import { type Event } from '../../../../base/common/event.js';
import type { Icon } from '../../../../base/common/icon.js';
import { type IDisposable } from '../../../../base/common/lifecycle.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IStatusbarEntryContainer } from '../../../browser/parts/statusbar/statusbarPart.js';

/** The side of the status bar that owns an entry. */
export enum StatusbarAlignment {
	Left = 'left',
	Right = 'right',
}

/** Semantic presentation applied to a status bar entry. */
export type StatusbarEntryKind = 'standard' | 'remote';

/** One icon-and-text segment rendered inside a grouped status bar entry. */
export interface IStatusbarEntrySegment {
	readonly icon?: Icon;
	readonly text: string;
}

/** Declarative content displayed by one status bar entry. */
export interface IStatusbarEntry {
	readonly showInAllWindows?: boolean;
	readonly icon?: Icon;
	readonly text: string;
	readonly segments?: readonly IStatusbarEntrySegment[];
	/** Rotates the entry's icon while its owning operation is pending. */
	readonly showProgress?: boolean;
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
export interface IStatusbarStyleOverride {
	/** Lower values take precedence. */
	readonly priority: number;
	readonly foreground?: ColorIdentifier;
	readonly background?: ColorIdentifier;
	readonly border?: ColorIdentifier;
}

export interface IStatusbarService {
	/** Resolves the live status bar in a Workbench window without duplicating its view state. */
	getPart(container: HTMLElement): IStatusbarEntryContainer;
	readonly onDidChangeStyle: Event<void>;
	readonly style: IStatusbarStyleOverride | undefined;
	overrideStyle(style: IStatusbarStyleOverride): IDisposable;
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
	createServiceIdentifier<IStatusbarService>('statusbarService');
