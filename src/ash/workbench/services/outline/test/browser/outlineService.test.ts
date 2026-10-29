import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IEditorPane } from '../../../../common/editor.js';
import { OutlineTarget, type IOutline, type IOutlineCreator } from '../../browser/outline.js';
import { OutlineService } from '../../browser/outlineService.js';

const pane: IEditorPane = {
	id: 'test', getId: () => 'test', getTitle: () => 'Test', getControl: () => undefined,
	onDidFocus: Event.None, onDidBlur: Event.None, focus: () => { }, hasFocus: () => false,
	setInput: async () => { }, clearInput: () => { }, layout: () => { }, setVisible: () => { }, isVisible: () => true, dispose: () => { }, [Symbol.dispose]: () => { },
};

suite('OutlineService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registration changes capability and returns the requested target', async () => {
		using service = new OutlineService();
		const calls: OutlineTarget[] = [];
		const creator: IOutlineCreator<IEditorPane, string> = {
			matches: (candidate): candidate is IEditorPane => candidate === pane,
			createOutline: async (_editor, target) => { calls.push(target); return undefined; },
		};
		const changes: boolean[] = [];
		using listener = service.onDidChange(() => changes.push(service.canCreateOutline(pane)));
		const registration = service.registerOutlineCreator(creator);
		assert.throws(() => service.registerOutlineCreator(creator), /already registered/);
		assert.equal(await service.createOutline(pane, OutlineTarget.OutlinePane, CancellationToken.None), undefined);
		registration.dispose();
		assert.deepEqual({ calls, changes, supported: service.canCreateOutline(pane) }, { calls: [OutlineTarget.OutlinePane], changes: [true, false], supported: false });
	});

	for (const stop of ['cancel', 'unregister', 'dispose'] as const) {
		test(`disposes a late result after ${stop}`, async () => {
			using service = new OutlineService();
			using token = new CancellationTokenSource();
			const pending = new DeferredPromise<IOutline<string>>();
			let disposed = 0;
			const outline: IOutline<string> = {
				uri: undefined, outlineKind: 'test', isEmpty: true, activeElement: undefined, onDidChange: Event.None,
				config: { treeDataSource: { getChildren: () => [] }, comparator: { compareByName: () => 0, compareByType: () => 0, compareByPosition: () => 0 }, options: { modelOptions: { identityProvider: { getId: value => value } }, renderElement: () => { throw new Error('Unused renderer'); } } },
				reveal: () => { }, dispose: () => { disposed++; }, [Symbol.dispose]: () => { disposed++; },
			};
			using registration = service.registerOutlineCreator({ matches: (candidate): candidate is IEditorPane => candidate === pane, createOutline: () => pending.p });
			const result = service.createOutline(pane, OutlineTarget.OutlinePane, token.token);
			if (stop === 'cancel') {
				token.cancel();
				// Cancellation must finish even if an external creator ignores the token.
				await assert.rejects(result, /cancelled/);
			} else if (stop === 'unregister') registration.dispose();
			else service.dispose();
			pending.complete(outline);
			if (stop !== 'cancel') assert.equal(await result, undefined);
			await pending.p;
			await Promise.resolve();
			assert.equal(disposed, 1);
		});
	}
});
