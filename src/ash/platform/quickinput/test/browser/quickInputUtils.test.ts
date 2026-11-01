import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import '../../../../editor/test/browser/testEditorDom.js';
import { quickInputButtonToAction, quickInputButtonsToActionArrays, renderQuickInputDescription } from '../../browser/quickInputUtils.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import type { IQuickInputButton } from '../../common/quickInput.js';

suite('Quick Input button actions', () => {
	test('classifies buttons without losing identity, context or toggle state', () => {
		const toggle = { checked: false };
		const buttons: IQuickInputButton[] = [{ label: 'Enable', toggle }, { tooltip: 'Details', secondary: true }];
		const calls: unknown[] = [];
		const actions = quickInputButtonsToActionArrays(buttons, 'row', (button, context) => { calls.push([button, context]); return 'done'; });
		assert.deepEqual(actions.primary.map(action => action.id), ['row-0']);
		assert.deepEqual(actions.secondary.map(action => action.id), ['row-1']);
		assert.equal(actions.primary[0].run('keyboard'), 'done');
		assert.equal(toggle.checked, true);
		assert.equal(actions.primary[0].checked, true);
		actions.primary[0].run();
		assert.equal(toggle.checked, false);
		actions.secondary[0].run();
		assert.deepEqual(calls, [[buttons[0], 'keyboard'], [buttons[0], undefined], [buttons[1], undefined]]);
		assert.equal(actions.secondary[0].tooltip, 'Details');
	});

	test('preserves the raw button contract and adds captions only for action arrays', () => {
		const raw = quickInputButtonToAction({ label: 'Caption', tooltip: 'Help', iconClass: 'custom-artwork', alwaysVisible: true }, 'single', () => { });
		assert.equal(raw.label, '');
		assert.equal(raw.tooltip, 'Help');
		assert.deepEqual(raw.class?.split(' '), ['custom-artwork', 'always-visible']);
		const toggle = { checked: false };
		const action = quickInputButtonToAction({ tooltip: 'Enable tool', toggle }, 'toggle', () => { });
		assert.equal(action.label, 'Enable tool');
		assert.equal(action.tooltip, '');
		action.run();
		assert.equal(action.checked, true);
		assert.ok(quickInputButtonToAction({ iconPath: { dark: URI.file('/icons/dark.svg') } }, 'path', () => { }).class);
		assert.equal(quickInputButtonsToActionArrays([{ label: 'Caption', tooltip: 'Help' }], 'array', () => { }).primary[0].label, 'Caption');
	});

	test('description links support click and keyboard activation and release their handlers', () => {
		using listeners = new DisposableStore();
		const container = document.createElement('div');
		const opened: string[] = [];
		renderQuickInputDescription('Read <b>literal</b> [guide](https://example.test "Docs") or [run](command:tool).', container, { disposables: listeners, callback: href => opened.push(href) });
		const links = [...container.querySelectorAll('a')];
		assert.equal(container.querySelector('b'), null);
		assert.deepEqual(links.map(link => [link.textContent, link.tabIndex]), [['guide', 0], ['run', 0]]);
		assert.equal(links[0].title, 'Docs');
		assert.match(links[1].title, /tool/);
		links[0].click();
		links[1].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
		links[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		assert.deepEqual(opened, ['https://example.test', 'command:tool', 'command:tool']);
		listeners.clear();
		links[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		assert.equal(opened.length, 3);
	});
});
