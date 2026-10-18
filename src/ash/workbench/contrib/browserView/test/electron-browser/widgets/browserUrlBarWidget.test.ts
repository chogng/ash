import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { promiseWithResolvers } from '../../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import type { IQuickInputService, IQuickPick } from '../../../../../../platform/quickinput/common/quickInput.js';
import type { BrowserEditorInput } from '../../../common/browserEditorInput.js';
import type { IBrowserUrlSuggestion, IBrowserUrlSuggestionProvider } from '../../../electron-browser/browserEditor.js';
import { BrowserUrlBarWidget, type IUrlPickerItem } from '../../../electron-browser/widgets/browserUrlBarWidget.js';

suite('Browser URL suggestions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('late provider results cannot replace the current query or navigate a replaced page', async () => {
		using f = fixture();
		const queries: Array<{ text: string; token: import('../../../../../../base/common/cancellation.js').CancellationToken; result: ReturnType<typeof promiseWithResolvers<readonly IBrowserUrlSuggestion[]>>; }> = [];
		const provider: IBrowserUrlSuggestionProvider = {
			getSuggestions: ({ text }, token) => {
				const result = promiseWithResolvers<readonly IBrowserUrlSuggestion[]>(); queries.push({ text, token, result }); return result.promise;
			}
		};
		f.widget.mountContributions([{ urlSuggestionProviders: [provider] }]);
		f.widget.openUrlPicker();
		f.pick.value = 'current'; f.changed.fire('current');
		assert.equal(queries[0]!.token.isCancellationRequested, true);
		queries[1]!.result.resolve([{ id: 'current', label: 'current', apply: () => { f.applied.push('current'); } }]);
		await settle();
		queries[0]!.result.resolve([{ id: 'old', label: 'old', apply: () => { f.applied.push('old'); } }]);
		await settle();
		assert.ok(f.pick.items.some(item => !('type' in item) && 'id' in item && item.id === 'current'));
		assert.ok(!f.pick.items.some(item => !('type' in item) && 'id' in item && item.id === 'old'));
		f.pick.selectedItems = f.pick.items.filter(item => !('type' in item) && 'id' in item && item.id === 'current') as IUrlPickerItem[];
		f.host.input = undefined;
		f.accepted.fire({ inBackground: false }); await settle();
		assert.deepEqual(f.applied, []);
	});
	test('accepting a suggestion cannot navigate a page replaced before the action runs', async () => {
		using f = fixture();
		f.widget.openUrlPicker();
		f.pick.selectedItems = [{ label: 'Captured', apply: () => { f.applied.push('captured'); } }];
		f.accepted.fire({ inBackground: false });
		f.host.input = undefined;
		await settle();
		assert.deepEqual(f.applied, []);
		assert.equal(f.focused, 0);
	});
	test('a slow accepted suggestion respects a later focus change', async () => {
		using f = fixture();
		const navigation = promiseWithResolvers<void>();
		f.widget.openUrlPicker();
		f.pick.selectedItems = [{ label: 'Slow', apply: () => navigation.promise }];
		f.accepted.fire({ inBackground: false });
		await settle();
		const button = f.dom.window.document.createElement('button');
		f.dom.window.document.body.append(button);
		button.focus();
		navigation.resolve();
		await settle();
		assert.equal(f.dom.window.document.activeElement, button);
		assert.equal(f.focused, 0);
	});
	test('keyboard dismissal returns to the page and clearing cancels an open suggestion picker', async () => {
		using f = fixture(); f.widget.refreshUrl();
		f.widget.inputElement.value = 'unfinished';
		f.widget.inputElement.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
		assert.equal(f.widget.value, 'https://example.test/');
		assert.equal(f.focused, 1);
		f.widget.openUrlPicker(); f.widget.clear();
		assert.equal(f.hidden, 1); assert.equal(f.widget.value, '');
		assert.equal(f.focused, 1);
	});
});
async function settle(): Promise<void> { for (let i = 0; i < 5; i++) { await Promise.resolve(); } }
function fixture() {
	const resources = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>');
	const changed = resources.add(new Emitter<string>());
	const accepted = resources.add(new Emitter<{ inBackground: boolean; }>());
	const hide = resources.add(new Emitter<void>());
	let isHidden = false;
	const f = { dom, changed, accepted, focused: 0, hidden: 0, applied: [] as string[] };
	const host = { input: { isDisposed: false, model: { state: { url: 'https://example.test/' } } } as unknown as BrowserEditorInput | undefined, ensureBrowserFocus: () => { f.focused++; } };
	const pick = {
		items: [], value: '', activeItems: [], selectedItems: [], onDidChangeValue: changed.event, onDidAccept: accepted.event, onDidHide: hide.event, onDidBlur: Event.None,
		show: () => { isHidden = false; }, hide: () => { if (!isHidden) { isHidden = true; f.hidden++; hide.fire(); } }, dispose: () => { pick.hide(); }, [Symbol.dispose]: () => { pick.hide(); },
	} as unknown as IQuickPick<IUrlPickerItem>;
	const quick = { createQuickPick: () => pick } as unknown as IQuickInputService;
	const widget = resources.add(new BrowserUrlBarWidget(host, dom.window.document.body, async text => { f.applied.push(text); }, error => { throw error; }, quick));
	return Object.assign(f, { widget, host, pick, [Symbol.dispose]: () => { resources.dispose(); dom.window.close(); } });
}
