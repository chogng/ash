import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { IAssetService, type AssetCatalog } from '../../../../../platform/assets/common/assetService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IHoverService } from '../../../../../platform/hover/browser/hoverService.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { PaneComposite } from '../../../../../workbench/browser/parts/views/paneComposite.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { registerTestComponentServices } from '../../../../../workbench/test/common/testEditorServices.js';
import { ViewDescriptorService } from '../../../../../workbench/services/views/browser/viewDescriptorService.js';
import { SessionsViewRegistry } from '../../../../common/views.js';
import { ILibraryService, LIBRARY_NAVIGATION_CONTAINER_ID, LIBRARY_DETAILS_CONTAINER_ID } from '../../browser/libraryService.js';
import '../../browser/library.contribution.js';

const catalog: AssetCatalog = {
	entries: [{ version: { assetId: 'asset', versionId: 'version', name: 'Campaign.png', source: URI.parse('file:/Campaign.png'), sha256: 'hash', mediaType: 'image/png', size: 10, width: 2, height: 1 }, addedAt: 1, favorite: true, collectionIds: ['collection'] }],
	collections: [{ id: 'collection', name: 'Campaign' }],
};

class LibraryFixture extends Disposable {
	public readonly environment = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
	public readonly services = this._register(new InstantiationService());
	public readonly contextKeys = this._register(new ContextKeyService());
	public readonly storage = this._register(new BrowserStorageService({ ownerWindow: this.environment.window as unknown as Window, workspaceId: 'library', backend: this.environment.window.localStorage, flushInterval: 0 }));
	public readonly library: ILibraryService;
	public readonly descriptors: ViewDescriptorService;
	public reads = 0;
	public pendingCatalog: DeferredPromise<AssetCatalog> | undefined;

	constructor() {
		super();
		this._register(toDisposable(() => this.environment.window.close()));
		for (const [id, descriptor] of getSingletonServiceDescriptors()) { this.services.registerSingleton(id, () => this.services.createInstance(descriptor.ctor, ...descriptor.staticArguments)); }
		this.services.registerInstance(IStorageService, this.storage);
		registerTestComponentServices(this.services, this.environment.window.document);
		this.services.registerInstance(IContextKeyService, this.contextKeys);
		this.services.registerInstance(IConfigurationService, { getValue: () => false } as unknown as IConfigurationService);
		this.services.registerInstance(IHoverService, { setupDelayedHover: () => Disposable.None } as unknown as IHoverService);
		this.services.registerInstance(IQuickInputService, { input: async () => undefined } as unknown as IQuickInputService);
		this.services.registerInstance(ICommandService, { executeCommand: async () => undefined } as unknown as ICommandService);
		this.services.registerInstance(IMenuService, new MenuService(this.services.get(ICommandService), this.contextKeys));
		this.services.registerInstance(IAssetService, {
			getCatalog: async () => { this.reads++; return this.pendingCatalog ? this.pendingCatalog.p : catalog; },
			readVersion: async () => new Uint8Array(),
		} as unknown as IAssetService);
		this.library = this.services.get(ILibraryService);
		this.descriptors = this._register(this.services.createInstance(ViewDescriptorService, { registry: SessionsViewRegistry }));
	}

	public open(id: string): PaneComposite {
		const viewContainer = this.descriptors.getViewContainerById(id)!;
		return this.services.createInstance(PaneComposite, this.environment.window.document.body, { viewContainer, model: this.descriptors.getViewContainerModel(id), contextKeyService: this.contextKeys, instantiationService: this.services });
	}
}

suite('Library independent container Views', () => {
	test('opens registered navigation before editor creation and retains browsing state when a View is recreated', async () => {
		using fixture = new LibraryFixture();
		await fixture.library.reload();
		{
			using navigation = fixture.open(LIBRARY_NAVIGATION_CONTAINER_ID);
			navigation.element.querySelector<HTMLButtonElement>('[data-library-category="collection"]')!.click();
			fixture.library.setQuery('Campaign');
			fixture.library.setViewMode('list');
			assert.deepEqual({ category: fixture.library.state.get().category, items: fixture.library.getEntries().map(entry => entry.version.name), editorCount: fixture.environment.window.document.querySelectorAll('.ash-library').length }, { category: 'collection', items: ['Campaign.png'], editorCount: 0 });
		}
		using restored = fixture.open(LIBRARY_NAVIGATION_CONTAINER_ID);
		assert.deepEqual({ category: restored.element.querySelector('[aria-current="page"]')?.textContent, query: fixture.library.state.get().query, mode: fixture.library.state.get().viewMode }, { category: 'Campaign', query: 'Campaign', mode: 'list' });
	});

	test('details reflects the shared selection independently of the editor and requests focus only on explicit close', async () => {
		using fixture = new LibraryFixture();
		await fixture.library.reload();
		using details = fixture.open(LIBRARY_DETAILS_CONTAINER_ID);
		const focused: string[] = [];
		using listener = fixture.library.onDidRequestItemFocus(asset => focused.push(asset));
		fixture.library.selectAsset('asset');
		assert.deepEqual([catalog.entries[0].version.name, catalog.entries[0].version.source.toString(), catalog.entries[0].version.versionId].map(value => details.element.textContent!.includes(value)), [true, true, true]);
		fixture.library.closeDetails();
		assert.deepEqual({ hidden: (details.element.querySelector('.ash-library-details') as HTMLElement).hidden, focused, editorCount: fixture.environment.window.document.querySelectorAll('.ash-library').length }, { hidden: true, focused: ['asset'], editorCount: 0 });
	});

	test('ignores an older catalog response while retaining the latest category and search', async () => {
		using fixture = new LibraryFixture();
		const previous = fixture.pendingCatalog = new DeferredPromise<AssetCatalog>();
		const first = fixture.library.reload();
		fixture.pendingCatalog = undefined;
		await fixture.library.reload();
		fixture.library.selectCategory('collection');
		fixture.library.setQuery('Campaign');
		await previous.complete({ entries: [], collections: [] });
		await first;
		assert.deepEqual({ category: fixture.library.state.get().category, names: fixture.library.getEntries().map(entry => entry.version.name), loading: fixture.library.state.get().loading }, { category: 'collection', names: ['Campaign.png'], loading: false });
	});
});
