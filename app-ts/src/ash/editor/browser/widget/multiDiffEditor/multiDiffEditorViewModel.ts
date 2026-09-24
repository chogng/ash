import { isFiniteNumber } from '../../../../base/common/numbers.js';
import { isCodeEditorViewState, type CodeEditorViewState } from '../codeEditor/codeEditorWidget.js';
import { type DiffEditorItemViewState } from './diffEditorItemTemplate.js';

export interface MultiDiffEditorLocation {
	readonly itemId: string;
	readonly rowIndex: number;
}

export interface MultiDiffEditorViewState {
	readonly scrollTop: number;
	readonly collapsedItemIds: readonly string[];
	readonly itemViewStates: readonly {
		readonly id: string;
		readonly original: CodeEditorViewState | null;
		readonly modified: CodeEditorViewState | null;
	}[];
}

/** Keeps file state independent from the lifetime of visible DOM templates. */
export class MultiDiffEditorViewModel {
	private itemIds: ReadonlySet<string>;
	private readonly collapsedItemIds = new Set<string>();
	private readonly itemViewStates = new Map<string, DiffEditorItemViewState>();
	private selectedChange: MultiDiffEditorLocation | undefined;

	constructor(items: readonly { readonly id: string }[]) {
		this.itemIds = new Set(items.map(item => item.id));
	}

	public setItems(items: readonly { readonly id: string }[]): void {
		this.itemIds = new Set(items.map(item => item.id));
		for (const id of this.collapsedItemIds) if (!this.itemIds.has(id)) this.collapsedItemIds.delete(id);
		for (const id of this.itemViewStates.keys()) if (!this.itemIds.has(id)) this.itemViewStates.delete(id);
		if (this.selectedChange && !this.itemIds.has(this.selectedChange.itemId)) this.selectedChange = undefined;
	}

	public get activeChange(): MultiDiffEditorLocation | undefined {
		return this.selectedChange;
	}

	public set activeChange(value: MultiDiffEditorLocation | undefined) {
		this.selectedChange = value;
	}

	public isCollapsed(itemId: string): boolean {
		return this.collapsedItemIds.has(itemId);
	}

	public toggleItem(itemId: string): boolean {
		if (!this.itemIds.has(itemId)) throw new RangeError(`Unknown multi-diff item '${itemId}'`);
		if (this.collapsedItemIds.has(itemId)) this.collapsedItemIds.delete(itemId);
		else this.collapsedItemIds.add(itemId);
		return this.collapsedItemIds.has(itemId);
	}

	public expand(itemId: string): boolean {
		return this.collapsedItemIds.delete(itemId);
	}

	public collapseAll(): boolean {
		const changed = this.collapsedItemIds.size !== this.itemIds.size;
		for (const id of this.itemIds) this.collapsedItemIds.add(id);
		return changed;
	}

	public expandAll(): boolean {
		if (this.collapsedItemIds.size === 0) return false;
		this.collapsedItemIds.clear();
		return true;
	}

	public saveItemViewState(itemId: string, state: DiffEditorItemViewState): void {
		this.itemViewStates.set(itemId, state);
	}

	public getItemViewState(itemId: string): DiffEditorItemViewState | undefined {
		return this.itemViewStates.get(itemId);
	}

	public saveViewState(scrollTop: number): MultiDiffEditorViewState {
		return {
			scrollTop,
			collapsedItemIds: [...this.collapsedItemIds],
			itemViewStates: [...this.itemViewStates].flatMap(([id, state]) =>
				state.original || state.modified ? [{ id, ...state }] : []),
		};
	}

	public restoreViewState(value: unknown): number {
		if (!isMultiDiffEditorViewState(value)) throw new TypeError('Invalid multi-diff editor view state');
		this.collapsedItemIds.clear();
		for (const id of value.collapsedItemIds) if (this.itemIds.has(id)) this.collapsedItemIds.add(id);
		this.itemViewStates.clear();
		for (const state of value.itemViewStates) {
			if (this.itemIds.has(state.id)) this.itemViewStates.set(state.id, state);
		}
		this.selectedChange = undefined;
		return value.scrollTop;
	}
}

function isMultiDiffEditorViewState(value: unknown): value is MultiDiffEditorViewState {
	if (!value || typeof value !== 'object') return false;
	const state = value as Partial<MultiDiffEditorViewState>;
	return isFiniteNumber(state.scrollTop) && state.scrollTop >= 0
		&& Array.isArray(state.collapsedItemIds) && state.collapsedItemIds.every((id: unknown) => typeof id === 'string')
		&& Array.isArray(state.itemViewStates) && state.itemViewStates.every((item: unknown) => {
			if (!item || typeof item !== 'object') return false;
			const entry = item as MultiDiffEditorViewState['itemViewStates'][number];
			return typeof entry.id === 'string'
				&& (entry.original === null || isCodeEditorViewState(entry.original))
				&& (entry.modified === null || isCodeEditorViewState(entry.modified));
		});
}
