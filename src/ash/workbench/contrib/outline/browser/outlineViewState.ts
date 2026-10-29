import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { OutlineSortOrder, type IOutlineViewState } from './outline.js';

/** Outline preferences are workspace view state, applied immediately to the retained tree. */
export class OutlineViewState extends Disposable implements IOutlineViewState {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private state: IOutlineViewState = { followCursor: false, filterOnType: true, sortBy: OutlineSortOrder.ByPosition };

	constructor(@IStorageService private readonly storage: IStorageService) {
		super();
		let value: unknown;
		try { value = JSON.parse(storage.get('outline/state', StorageScope.WORKSPACE, '{}')); } catch { return; }
		if (!value || typeof value !== 'object' || Array.isArray(value)) return;
		const saved = value as Record<string, unknown>;
		this.state = {
			followCursor: typeof saved.followCursor === 'boolean' ? saved.followCursor : false,
			filterOnType: typeof saved.filterOnType === 'boolean' ? saved.filterOnType : true,
			sortBy: saved.sortBy === OutlineSortOrder.ByName || saved.sortBy === OutlineSortOrder.ByKind ? saved.sortBy : OutlineSortOrder.ByPosition,
		};
	}

	public get followCursor(): boolean { return this.state.followCursor; }
	public set followCursor(value: boolean) { this.update('followCursor', value); }
	public get filterOnType(): boolean { return this.state.filterOnType; }
	public set filterOnType(value: boolean) { this.update('filterOnType', value); }
	public get sortBy(): OutlineSortOrder { return this.state.sortBy; }
	public set sortBy(value: OutlineSortOrder) { this.update('sortBy', value); }

	private update<K extends keyof IOutlineViewState>(key: K, value: IOutlineViewState[K]): void {
		if (this.state[key] === value) return;
		this.state = { ...this.state, [key]: value };
		this.storage.store('outline/state', JSON.stringify(this.state), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.changed.fire();
	}
}
