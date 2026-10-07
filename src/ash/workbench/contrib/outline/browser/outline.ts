import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import type { IView } from '../../../common/views.js';

export const enum OutlineSortOrder {
	ByPosition,
	ByName,
	ByKind,
}

export interface IOutlineViewState {
	followCursor: boolean;
	filterOnType: boolean;
	sortBy: OutlineSortOrder;
}

export namespace IOutlinePane {
	export const Id = 'outline';
}

export interface IOutlinePane extends IView {
	readonly outlineViewState: IOutlineViewState;
	collapseAll(): void;
	expandAll(): void;
}

export const ctxFocused = new RawContextKey<boolean>('outlineFocused', false);
