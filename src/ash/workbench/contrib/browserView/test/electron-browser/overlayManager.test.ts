import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { DialogsModel, IDialogsModel } from '../../../../common/dialogs.js';
import { BrowserOverlayManager } from '../../electron-browser/overlayManager.js';

suite('Browser overlay observation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('unrelated sibling mutations do not recheck existing overlays', async () => {
		using f = fixture();
		let changes = 0;
		using listener = f.manager.onDidChangeOverlayState(() => changes++);
		const overlay = f.dom.window.document.createElement('div');
		overlay.className = 'ash-hover';
		overlay.hidden = true;
		f.dom.window.document.body.append(overlay);
		await flush();
		changes = 0;
		for (let i = 0; i < 30; i++) {
			const unrelated = f.dom.window.document.createElement('div');
			f.dom.window.document.body.append(unrelated);
			await flush();
			unrelated.remove();
			await flush();
		}
		assert.equal(changes, 0);
		overlay.hidden = false;
		await flush();
		assert.equal(changes, 1);
	});

	test('removing overlay identity and hiding its ancestor both update overlap', async () => {
		using f = fixture();
		let changes = 0;
		using listener = f.manager.onDidChangeOverlayState(() => changes++);
		const parent = f.dom.window.document.createElement('div');
		const overlay = f.dom.window.document.createElement('div');
		overlay.className = 'ash-hover';
		overlay.getBoundingClientRect = () => new f.dom.window.DOMRect(0, 0, 100, 100);
		parent.append(overlay);
		f.dom.window.document.body.append(parent);
		await flush();
		assert.equal(f.manager.getOverlappingOverlays(overlay).length, 1);
		overlay.className = '';
		await flush();
		assert.deepEqual([changes, f.manager.getOverlappingOverlays(overlay).length], [2, 0]);
		overlay.setAttribute('data-browser-overlay', '');
		await flush();
		assert.deepEqual([changes, f.manager.getOverlappingOverlays(overlay).length], [3, 1]);
		parent.hidden = true;
		await flush();
		assert.deepEqual([changes, f.manager.getOverlappingOverlays(overlay).length], [4, 0]);
		parent.hidden = false;
		await flush();
		overlay.removeAttribute('data-browser-overlay');
		await flush();
		assert.deepEqual([changes, f.manager.getOverlappingOverlays(overlay).length], [6, 0]);
	});

	test('document observation exists only while consumers need it', () => {
		using f = fixture();
		const Original = f.dom.window.MutationObserver;
		let active = 0;
		f.dom.window.MutationObserver = class extends Original {
			private observing = false;
			override observe(target: Node, options?: MutationObserverInit): void {
				super.observe(target, options);
				if (!this.observing) { this.observing = true; active++; }
			}
			override disconnect(): void {
				super.disconnect();
				if (this.observing) { this.observing = false; active--; }
			}
		};
		assert.equal(active, 0);
		using first = f.manager.onDidChangeOverlayState(() => { });
		using second = f.manager.onDidChangeOverlayState(() => { });
		assert.equal(active, 1);
		first.dispose();
		assert.equal(active, 1);
		second.dispose();
		assert.equal(active, 0);
		using restored = f.manager.onDidChangeOverlayState(() => { });
		assert.equal(active, 1);
		f.manager.dispose();
		assert.equal(active, 0);
	});
});

function fixture() {
	const store = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>');
	store.add(toDisposable(() => dom.window.close()));
	const dialogs = store.add(new DialogsModel());
	const services = store.add(new InstantiationService(new ServiceCollection(
		[IDialogsModel, dialogs],
		[IContextMenuService, { onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu() { }, hideContextMenu() { } }],
	)));
	const manager = store.add(services.createInstance(BrowserOverlayManager, dom.window as unknown as Window & typeof globalThis));
	return Object.assign(store, { dom, manager });
}

function flush(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }
