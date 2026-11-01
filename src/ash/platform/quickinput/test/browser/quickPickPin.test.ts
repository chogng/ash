import '../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { BrowserStorageService } from '../../../../workbench/services/storage/browser/storageService.js';
import { StorageScope, StorageTarget } from '../../../storage/common/storage.js';
import type { IQuickPick, IQuickPickItem, IQuickPickItemButton, IQuickPickSeparator } from '../../common/quickInput.js';
import { showWithPinnedItems } from '../../browser/quickPickPin.js';

class PinPicker extends Disposable {
	items: readonly (IQuickPickItem | IQuickPickSeparator)[] = [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta', buttons: [{ id: 'details', label: 'Details' }] }];
	activeItems: readonly IQuickPickItem[] = [];
	value = '';
	valueSelection = { start: 0, end: 0 };
	sortByLabel = true;
	readonly triggered = this._register(new Emitter<{ item: IQuickPickItem; button: IQuickPickItemButton; }>());
	readonly changed = this._register(new Emitter<string>());
	readonly onDidTriggerItemButton = this.triggered.event;
	readonly onDidChangeValue = this.changed.event;
	show(): void { }
	focus(): void { }
}

suite('Pinned Quick Pick behavior', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const filterDuplicates of [false, true]) {
		test(`deduplicates only pinned copies and retains the source catalog (${filterDuplicates})`, () => {
			const dom = new JSDOM('', { url: 'https://pins.test' });
			using windowLifetime = toDisposable(() => dom.window.close());
			using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'pins', flushInterval: 0 });
			storage.store('pins', JSON.stringify(['beta', 'beta']), StorageScope.WORKSPACE, StorageTarget.MACHINE);
			using picker = new PinPicker();
			const source = [...picker.items];
			using pins = showWithPinnedItems(storage, 'pins', picker as unknown as IQuickPick<IQuickPickItem>, filterDuplicates);
			const rows = () => picker.items.filter((item): item is IQuickPickItem => !('type' in item));
			assert.deepEqual(rows().map(item => item.label), filterDuplicates ? ['Beta', 'Alpha', 'Beta'] : ['Beta', 'Beta', 'Alpha', 'Beta']);
			assert.equal(rows()[0].buttons?.[0].id, 'quickInput.unpin');
			assert.equal(rows().at(-1)?.buttons?.[0].id, 'quickInput.pin');
			assert.deepEqual(source, [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta', buttons: [{ id: 'details', label: 'Details' }] }]);
			const original = rows().at(-1)!;
			picker.triggered.fire({ item: original, button: original.buttons![0] });
			assert.ok(storage.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).includes('pins'));
			assert.deepEqual(rows().map(item => item.label), filterDuplicates ? ['Beta', 'Alpha', 'Beta'] : ['Beta', 'Beta', 'Beta', 'Alpha', 'Beta']);
			picker.value = 'Beta'; picker.changed.fire('Beta');
			assert.deepEqual(rows().map(item => item.label), ['Alpha', 'Beta']);
			assert.equal(rows()[1].buttons?.[0].id, 'quickInput.pin');
			assert.equal(picker.sortByLabel, true);
			picker.value = ''; picker.changed.fire('');
			const pinned = rows()[0];
			picker.triggered.fire({ item: pinned, button: pinned.buttons![0] });
			assert.deepEqual(rows().map(item => item.label), ['Alpha', 'Beta']);
			assert.deepEqual(JSON.parse(storage.get('pins', StorageScope.WORKSPACE)!), []);
		});
	}

	test('resolves legacy label records against the current catalog without resurrecting stale entries', () => {
		const dom = new JSDOM('', { url: 'https://pins.test' });
		using windowLifetime = toDisposable(() => dom.window.close());
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'legacy', flushInterval: 0 });
		storage.store('pins', JSON.stringify([{ label: 'Beta' }, { label: 'Removed' }, null]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		using picker = new PinPicker();
		using pins = showWithPinnedItems(storage, 'pins', picker as unknown as IQuickPick<IQuickPickItem>, true);
		assert.deepEqual(picker.items.map(item => item.label), ['Pinned', 'Beta', undefined, 'Alpha', 'Beta']);
	});
});
