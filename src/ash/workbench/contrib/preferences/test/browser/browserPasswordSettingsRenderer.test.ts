import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { installEditorTestDom } from '../../../../../editor/test/browser/editorTestGlobals.js';
import { getWindowById } from '../../../../../base/browser/window.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IBrowserPasswordService, BrowserPasswordState } from '../../../../../platform/browserView/common/browserPasswordService.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import type { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { DialogResult } from '../../../../../platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../../services/dialogs/common/dialogService.js';
import { BrowserPasswordSettingsRenderer } from '../../browser/browserPasswordSettingsRenderer.js';

suite('Saved website password settings', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const settle = () => new Promise<void>(resolve => setImmediate(resolve));
	function fixture() {
		const store = new DisposableStore();
		const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test/' });
		store.add(toDisposable(() => dom.window.close()));
		store.add(installEditorTestDom(dom, ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent']));
		store.add(getWindowById(1)!.disposables);
		const changed = store.add(new Emitter<void>());
		const node = document.createElement('div'); document.body.append(node); store.add(toDisposable(() => node.remove()));
		const updates: unknown[] = []; const deleted: string[] = [];
		const state: BrowserPasswordState = { available: true, corrupted: 0, entries: [{ id: 'test-account', origin: 'https://example.test', username: 'test-user', scope: 'global' }] };
		const service: IBrowserPasswordService = { onDidChange: changed.event, readState: async () => state, update: async (...args) => { updates.push(args); }, delete: async id => { deleted.push(id); }, clear: async () => { deleted.push('*'); } };
		const dialogs = store.add(new DialogService());
		const configuration = store.add(new InMemoryConfigurationService());
		const renderer = store.add(new BrowserPasswordSettingsRenderer(node, service, dialogs, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService, configuration));
		return { [Symbol.dispose]: () => store.dispose(), renderer, dialogs, service, state, node: renderer.domNode, updates, deleted };
	}

	test('metadata can be filtered, edited with a fresh masked password and deleted through confirmation', async () => {
		using f = fixture(); f.renderer.setVisible(true); await settle();
		assert.equal(f.node.querySelectorAll('li').length, 1);
		const search = f.node.querySelector('input')!; search.value = 'absent'; search.dispatchEvent(new window.Event('input', { bubbles: true }));
		assert.equal(f.node.querySelectorAll('li').length, 0);
		search.value = ''; search.dispatchEvent(new window.Event('input', { bubbles: true }));
		f.node.querySelector<HTMLButtonElement>('button[aria-label^="Edit account"]')!.click();
		const edit = f.dialogs.model.dialogs[0]!; assert.equal(edit.request.kind, 'input');
		if (edit.request.kind !== 'input') { throw new Error('Expected input'); }
		assert.equal(edit.request.inputs[0]!.value, 'test-user'); assert.equal(edit.request.inputs[1]!.type, 'password'); assert.equal(edit.request.inputs[1]!.value, undefined);
		edit.close({ button: DialogResult.Primary, values: ['renamed', 'new-password'] }); await settle();
		assert.deepEqual(f.updates, [['test-account', 'renamed', 'new-password']]);
		f.node.querySelector<HTMLButtonElement>('button[aria-label^="Delete account"]')!.click();
		assert.deepEqual(f.deleted, []); f.dialogs.model.dialogs[0]!.close({ button: DialogResult.Cancel }); await settle(); assert.deepEqual(f.deleted, []);
		f.node.querySelector<HTMLButtonElement>('button[aria-label^="Delete account"]')!.click();
		f.dialogs.model.dialogs[0]!.close({ button: DialogResult.Primary }); await settle(); assert.deepEqual(f.deleted, ['test-account']);
	});

	test('a late metadata read cannot overwrite a hidden or disposed settings page', async () => {
		using f = fixture(); const pending = promiseWithResolvers<BrowserPasswordState>();
		f.service.readState = () => pending.promise; f.renderer.setVisible(true); f.renderer.setVisible(false);
		pending.resolve(f.state); await settle(); assert.equal(f.node.querySelectorAll('li').length, 0);
		f.renderer.dispose(); await settle(); assert.equal(f.node.isConnected, false);
	});
});
