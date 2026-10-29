import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/** Profile visibility state; registered content and ordering remain in the entry service. */
export class StatusbarViewModel extends Disposable {
	private static readonly HIDDEN_ENTRIES_KEY = 'workbench.statusbar.hidden';
	private hidden = new Set<string>();
	private readonly visibilityChanges = this._register(new Emitter<{ id: string; visible: boolean; }>());
	readonly onDidChangeEntryVisibility = this.visibilityChanges.event;

	constructor(@IStorageService private readonly storageService: IStorageService) {
		super();
		this.readVisibility();
		this._register(storageService.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key === StatusbarViewModel.HIDDEN_ENTRIES_KEY) {
				this.readVisibility();
			}
		}));
	}

	isHidden(id: string): boolean {
		return this.hidden.has(id);
	}

	hide(id: string): void {
		if (this.isDisposed || this.hidden.has(id)) return;
		this.storeVisibility(new Set([...this.hidden, id]));
	}

	show(id: string): void {
		if (this.isDisposed || !this.hidden.has(id)) return;
		const next = new Set(this.hidden);
		next.delete(id);
		this.storeVisibility(next);
	}

	private storeVisibility(hidden: ReadonlySet<string>): void {
		// Storage publishes local and external changes through the same path, so
		// multiple Parts never need a second visibility owner or a write-back loop.
		if (hidden.size === 0) {
			this.storageService.remove(StatusbarViewModel.HIDDEN_ENTRIES_KEY, StorageScope.PROFILE);
		} else {
			this.storageService.store(StatusbarViewModel.HIDDEN_ENTRIES_KEY, JSON.stringify([...hidden]), StorageScope.PROFILE, StorageTarget.USER);
		}
	}

	private readVisibility(): void {
		const source = this.storageService.get(StatusbarViewModel.HIDDEN_ENTRIES_KEY, StorageScope.PROFILE);
		let ids: unknown;
		try {
			ids = source === undefined ? [] : JSON.parse(source);
			if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || id.length === 0)) {
				throw new TypeError('Expected an array of non-empty status bar entry IDs');
			}
		} catch (error) {
			// A malformed external write must not discard the last usable state or
			// overwrite the stored value before its owner can repair it.
			console.warn('Invalid stored status bar visibility', error);
			return;
		}
		const previous = this.hidden;
		this.hidden = new Set(ids as string[]);
		for (const id of new Set([...previous, ...this.hidden])) {
			if (previous.has(id) !== this.hidden.has(id)) {
				this.visibilityChanges.fire({ id, visible: !this.hidden.has(id) });
			}
		}
	}
}
