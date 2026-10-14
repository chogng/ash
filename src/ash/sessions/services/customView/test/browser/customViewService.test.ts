import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { constObservable } from '../../../../../base/common/observable.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { AbstractCustomView } from '../../browser/customView.js';
import { CustomViewService } from '../../browser/customViewService.js';

class TestView extends AbstractCustomView {
	readonly title = constObservable('Test');

	render(container: HTMLElement): void { container.textContent = 'Test'; }

	layout(): void { }
}

test('Custom View restoration waits for registration and repeated opens retain their source', () => {
	const dom = new JSDOM('', { url: 'https://custom-view.test' });
	try {
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'test', flushInterval: 0 });
		storage.store('sessions.activeCustomView', 'test', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		using service = new CustomViewService(new NullLoggerService(), storage);
		assert.equal(service.activeCustomView.get(), undefined);
		using registration = service.registerCustomView({ id: 'test', ctor: new SyncDescriptor(TestView) });
		assert.equal(service.activeCustomViewOpen.get()?.source, 'restore');
		const restored = service.activeCustomViewOpen.get();
		service.showCustomView('test');
		assert.notEqual(service.activeCustomViewOpen.get(), restored);
		assert.equal(service.activeCustomViewOpen.get()?.source, 'explicit');
		service.showCustomView('test', { source: 'history' });
		assert.equal(service.activeCustomViewOpen.get()?.source, 'history');
		service.hideCustomView();
		assert.equal(service.activeCustomView.get(), undefined);
		assert.equal(storage.get('sessions.activeCustomView', StorageScope.WORKSPACE), undefined);
	} finally { dom.window.close(); }
});

test('An unavailable Custom View cannot restore, and unregistering the active descriptor hides it', () => {
	const dom = new JSDOM('', { url: 'https://custom-view.test' });
	try {
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'test', flushInterval: 0 });
		storage.store('sessions.activeCustomView', 'test', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		using service = new CustomViewService(new NullLoggerService(), storage);
		using registration = service.registerCustomView({ id: 'test', ctor: new SyncDescriptor(TestView) }, { restore: false });
		assert.equal(service.activeCustomView.get(), undefined);
		assert.equal(storage.get('sessions.activeCustomView', StorageScope.WORKSPACE), undefined);
		service.showCustomView('test');
		registration.dispose();
		assert.equal(service.activeCustomView.get(), undefined);
	} finally { dom.window.close(); }
});
