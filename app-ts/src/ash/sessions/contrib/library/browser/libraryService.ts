import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IAssetService, type AssetCatalog, type AssetCatalogEntry } from '../../../../platform/assets/common/assetService.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export const LIBRARY_NAVIGATION_CONTAINER_ID = 'sessions.library.navigation';
export const LIBRARY_DETAILS_CONTAINER_ID = 'sessions.library.details';

export interface LibraryState {
	readonly catalog: AssetCatalog;
	readonly category: string;
	readonly selected: string | undefined;
	readonly query: string;
	readonly sort: 'recent' | 'name';
	readonly viewMode: 'grid' | 'list';
	readonly loading: boolean;
	readonly busy: boolean;
	readonly message: string | undefined;
}

/** Window-local browsing state shared by independently hosted editor and Views. Asset storage remains with IAssetService. */
export interface ILibraryService {
	readonly state: IObservable<LibraryState>;
	readonly onDidRequestItemFocus: Event<string>;
	selectCategory(category: string): void;
	selectAsset(assetId: string | undefined): void;
	setQuery(query: string): void;
	setSort(sort: 'recent' | 'name'): void;
	setViewMode(mode: 'grid' | 'list'): void;
	closeDetails(): void;
	reload(): Promise<void>;
	runMutation(operation: () => Promise<void>): Promise<void>;
	importFiles(files: readonly File[]): Promise<void>;
	createCollection(): Promise<void>;
	getEntries(): readonly AssetCatalogEntry[];
	getCategoryTitle(): string;
	getAccessibleContent(): string;
}

export const ILibraryService = createServiceIdentifier<ILibraryService>('libraryService');

export class LibraryService extends Disposable implements ILibraryService {
	private readonly browsing;
	public readonly state: IObservable<LibraryState>;
	private loadSequence = 0;
	private readonly itemFocus = this._register(new Emitter<string>());
	public readonly onDidRequestItemFocus = this.itemFocus.event;

	constructor(
		@IAssetService private readonly assets: IAssetService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IStorageService private readonly storage: IStorageService,
	) {
		super();
		const viewMode = storage.get('sessions.library.viewMode', StorageScope.PROFILE);
		if (viewMode !== undefined && viewMode !== 'grid' && viewMode !== 'list') { throw new TypeError('Invalid Library view mode'); }
		this.browsing = observableValue<LibraryState>(this, { catalog: { entries: [], collections: [] }, category: 'all', selected: undefined, query: '', sort: 'recent', viewMode: viewMode ?? 'grid', loading: false, busy: false, message: undefined });
		this.state = this.browsing;
	}

	private update(change: Partial<LibraryState>): void { this.browsing.set({ ...this.state.get(), ...change }); }
	public selectCategory(category: string): void { this.update({ category, selected: undefined }); }
	public selectAsset(selected: string | undefined): void { this.update({ selected }); }
	public setQuery(query: string): void { this.update({ query, selected: undefined }); }
	public setSort(sort: 'recent' | 'name'): void { this.update({ sort }); }
	public setViewMode(viewMode: 'grid' | 'list'): void {
		this.update({ viewMode });
		this.storage.store('sessions.library.viewMode', viewMode, StorageScope.PROFILE, StorageTarget.USER);
	}
	public closeDetails(): void {
		const selected = this.state.get().selected;
		this.selectAsset(undefined);
		if (selected) { this.itemFocus.fire(selected); }
	}

	public async reload(): Promise<void> {
		const sequence = ++this.loadSequence;
		this.update({ loading: true, message: undefined });
		try {
			const catalog = await this.assets.getCatalog();
			if (this.isDisposed || sequence !== this.loadSequence) { return; }
			const current = this.state.get();
			const category = ['all', 'favorites', 'images', ...catalog.collections.map(collection => collection.id)].includes(current.category) ? current.category : 'all';
			this.update({ catalog, category });
		} catch (error) {
			if (this.isDisposed || sequence !== this.loadSequence) { return; }
			this.update({ message: localize('library.loadFailed', 'Could not load the library. Choose Refresh to retry. {0}', String(error)) });
		} finally {
			if (!this.isDisposed && sequence === this.loadSequence) { this.update({ loading: false }); }
		}
	}

	public async runMutation(operation: () => Promise<void>): Promise<void> {
		if (this.state.get().busy) { return; }
		this.update({ busy: true });
		try { await operation(); await this.reload(); }
		catch (error) {
			if (!this.isDisposed) {
				await this.reload();
				this.update({ message: localize('library.operationFailed', 'Could not update the library. {0}', String(error)) });
			}
		} finally {
			if (!this.isDisposed) { this.update({ busy: false }); }
		}
	}

	public async importFiles(files: readonly File[]): Promise<void> {
		await this.runMutation(async () => {
			for (const file of files) {
				await this.assets.importImage({ assetId: generateUuid(), versionId: generateUuid(), name: file.name, source: URI.from({ scheme: 'file-upload', path: `/${file.name}` }), bytes: new Uint8Array(await file.arrayBuffer()) });
			}
			this.update({ category: 'all', query: '', selected: undefined });
		});
	}

	public async createCollection(): Promise<void> {
		const name = await this.quickInput.input({ title: localize('library.newCollection', 'New collection'), placeHolder: localize('library.collectionName', 'Collection name'), validateInput: async value => value.trim().length === 0 || new TextEncoder().encode(value.trim()).length > 512 ? localize('library.invalidCollection', 'Enter a collection name of at most 512 bytes.') : undefined });
		if (name === undefined || this.isDisposed) { return; }
		await this.runMutation(() => this.assets.createCollection({ id: generateUuid(), name: name.trim() }));
	}

	public getEntries(): readonly AssetCatalogEntry[] {
		const state = this.state.get();
		const query = state.query.trim().toLocaleLowerCase();
		return state.catalog.entries.filter(entry => {
			const included = state.category === 'all' || state.category === 'images' || (state.category === 'favorites' ? entry.favorite : entry.collectionIds.includes(state.category));
			return included && `${entry.version.name} ${entry.version.source.toString()}`.toLocaleLowerCase().includes(query);
		}).sort((left, right) => state.sort === 'name' ? left.version.name.localeCompare(right.version.name) : right.addedAt - left.addedAt);
	}

	public getCategoryTitle(): string {
		const state = this.state.get();
		if (state.category === 'all') { return localize('library.all', 'All'); }
		if (state.category === 'favorites') { return localize('library.favorites', 'Favorites'); }
		if (state.category === 'images') { return localize('library.images', 'Images'); }
		return state.catalog.collections.find(collection => collection.id === state.category)!.name;
	}

	public getAccessibleContent(): string {
		return [this.getCategoryTitle(), this.state.get().message, ...this.getEntries().map(entry => localize('library.accessibleEntry', '{0}; {1} × {2}; {3}; source: {4}; version: {5}', entry.version.name, entry.version.width, entry.version.height, entry.favorite ? localize('library.favorite', 'Favorite') : '', entry.version.source.toString(), entry.version.versionId))].join('\n');
	}
}
