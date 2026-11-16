import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import type { IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IHoverService } from '../../../../../platform/hover/browser/hoverService.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IBrowserDownloadService, type BrowserDownload } from '../../../../../platform/browserView/common/browserDownloads.js';
import { BrowserDownloadsView } from '../../electron-browser/features/browserDownloadsFeature.js';

suite('Browser download interactions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('search and context actions distinguish deleting a file from removing its record', async () => {
		using fixture = createFixture();
		await fixture.view.show(fixture.trigger);
		const root = fixture.root.querySelector<HTMLElement>('.ash-browser-downloads')!;
		const search = root.querySelector<HTMLInputElement>('input')!;
		assert.equal(fixture.document.activeElement, search);
		search.value = 'report';
		search.dispatchEvent(new fixture.window.Event('input', { bubbles: true }));
		const rows = () => root.querySelectorAll<HTMLElement>('[data-download-id]');
		assert.equal(rows().length, 1);
		rows()[0]!.dispatchEvent(new fixture.window.MouseEvent('contextmenu', { bubbles: true }));
		const actions = fixture.menu!.getActions();
		assert.deepEqual(actions.map(action => action.id), ['download.open', 'download.show', 'download.copy', 'download.deleteFile', 'download.remove']);
		await actions.find(action => action.id === 'download.copy')!.run();
		await fixture.flush();
		assert.deepEqual(fixture.copied, ['https://example.test/report.pdf']);
		const deleteButton = root.querySelector<HTMLButtonElement>('[aria-label="Delete file: report.pdf"]')!;
		deleteButton.click();
		await fixture.flush();
		assert.match(root.textContent!, /File deleted/u);
		rows()[0]!.dispatchEvent(new fixture.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
		await fixture.menu!.getActions().find(action => action.id === 'download.remove')!.run();
		await fixture.flush();
		assert.equal(rows().length, 0);
		assert.deepEqual(fixture.operations, ['deleteFile', 'remove']);
		assert.deepEqual(fixture.errors, []);
	});

	test('active downloads cannot mutate their files, and Escape restores the trigger focus', async () => {
		using fixture = createFixture();
		await fixture.view.show(fixture.trigger);
		const root = fixture.root.querySelector<HTMLElement>('.ash-browser-downloads')!;
		const active = root.querySelector<HTMLElement>('[data-download-id="active"]')!;
		active.dispatchEvent(new fixture.window.MouseEvent('contextmenu', { bubbles: true }));
		assert.deepEqual(fixture.menu!.getActions().map(action => [action.id, action.enabled]), [
			['download.open', false], ['download.show', false], ['download.copy', true], ['download.deleteFile', false], ['download.remove', false],
		]);
		fixture.menu!.onHide?.(true);
		root.querySelector<HTMLInputElement>('input')!.dispatchEvent(new fixture.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.equal(fixture.root.querySelector('.ash-browser-downloads'), null);
		assert.equal(fixture.document.activeElement, fixture.trigger);
	});

	test('history opened from settings stays inside its modal focus scope', async () => {
		using fixture = createFixture(true);
		await fixture.view.show();
		const panel = fixture.root.querySelector<HTMLElement>('.ash-browser-downloads')!;
		assert.equal(fixture.dialog?.contains(panel), true);
		const search = panel.querySelector<HTMLInputElement>('input')!;
		assert.equal(fixture.document.activeElement, search);
		search.dispatchEvent(new fixture.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.equal(fixture.root.querySelector('.ash-browser-downloads'), null);
		assert.equal(fixture.document.activeElement, fixture.trigger);
	});

	test('the history command replaces a toolbar popup when settings owns focus', async () => {
		using fixture = createFixture();
		await fixture.view.show(fixture.trigger);
		const dialog = fixture.document.createElement('dialog');
		dialog.setAttribute('open', '');
		const history = fixture.document.createElement('button');
		dialog.append(history); fixture.root.append(dialog); history.focus();
		await fixture.view.show();
		const panel = fixture.root.querySelector('.ash-browser-downloads')!;
		assert.equal(dialog.contains(panel), true);
		assert.equal(fixture.root.querySelectorAll('.ash-browser-downloads').length, 1);
	});
});

function createFixture(modal = false) {
	const resources = new DisposableStore();
	const window = browserEnvironment.window;
	const document = window.document;
	const root = document.createElement('div'); document.body.append(root);
	resources.add(toDisposable(() => root.remove()));
	resources.add(setARIAContainer(root));
	const dialog = modal ? document.createElement('dialog') : undefined;
	if (dialog) { dialog.setAttribute('open', ''); root.append(dialog); }
	for (const element of [root, document.body, document.documentElement, ...dialog ? [dialog] : []]) {
		const previous = Object.getOwnPropertyDescriptor(element, 'scrollTo');
		Object.defineProperty(element, 'scrollTo', { configurable: true, value: () => { } });
		resources.add(toDisposable(() => {
			if (previous) Object.defineProperty(element, 'scrollTo', previous);
			else Reflect.deleteProperty(element, 'scrollTo');
		}));
	}
	const trigger = document.createElement('button'); (dialog ?? root).append(trigger); trigger.focus();
	// JSDOM has no layout; focus restoration checks whether the trigger is rendered.
	trigger.getClientRects = () => [trigger.getBoundingClientRect()] as unknown as DOMRectList;
	const changed = resources.add(new Emitter<void>());
	let items: BrowserDownload[] = [
		{ id: 'complete', filename: 'report.pdf', path: '/tmp/report.pdf', url: 'https://example.test/report.pdf', time: 2, receivedBytes: 10, totalBytes: 10, state: 'completed' },
		{ id: 'active', filename: 'archive.zip', path: '/tmp/archive.zip', url: 'https://example.test/archive.zip', time: 1, receivedBytes: 5, totalBytes: 10, state: 'progressing' },
	];
	const operations: string[] = []; const copied: string[] = []; const errors: unknown[] = [];
	let menu: IContextMenuDelegate | undefined;
	const services = resources.add(new InstantiationService());
	services.registerInstance(IBrowserDownloadService, {
		onDidChange: changed.event, getState: async () => ({ directory: '/tmp', items }), configure: async () => { }, chooseDirectory: async () => undefined,
		perform: async (id, action) => {
			operations.push(action);
			if (action === 'deleteFile') items = items.map(item => item.id === id ? { ...item, state: 'deleted' } : item);
			if (action === 'remove') items = items.filter(item => item.id !== id);
			changed.fire();
		},
	});
	services.registerInstance(IContextViewService, { container: root } as unknown as IContextViewService);
	services.registerInstance(IContextMenuService, { showContextMenu: (delegate: IContextMenuDelegate) => { menu = delegate; } } as unknown as IContextMenuService);
	services.registerInstance(IHoverService, { setupDelayedHover: () => Disposable.None } as unknown as IHoverService);
	services.registerInstance(IClipboardService, { writeText: async (value: string) => { copied.push(value); } } as unknown as IClipboardService);
	services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
	services.registerInstance(INotificationService, { error: (error: unknown) => { errors.push(error); } } as unknown as INotificationService);
	const view = resources.add(services.createInstance(BrowserDownloadsView));
	return {
		root, dialog, trigger, window, document, view, operations, copied, errors, get menu() { return menu; },
		flush: () => new Promise<void>(resolve => setTimeout(resolve, 0)), [Symbol.dispose]: () => resources.dispose(),
	};
}
