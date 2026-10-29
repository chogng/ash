import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { CanvasDefinitionStore, type ICanvasDefinitionSource } from '../../common/canvasDefinitionStore.js';
import type { ICanvasDefinition } from '../../common/canvas.js';

suite('Canvas definition refreshes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const definition: ICanvasDefinition = {
		canvasId: 'board',
		extensionId: 'test.extension',
		extensionSource: 'user',
		displayName: 'Board',
		description: '',
		requiresInput: false,
	};
	const owner = (id: string) => ({
		providerId: 'local-agent-host',
		session: URI.parse('ash-session:/' + id),
		chat: URI.parse('ash-thread:/' + id),
	});
	const log = { error: () => {} } as unknown as ILogService;
	const settle = () => new Promise<void>(resolve => setImmediate(resolve));

	test('retains authoritative definitions through pending, failed and non-authoritative refreshes', async () => {
		using resources = new DisposableStore();
		let result: readonly ICanvasDefinition[] | undefined = [
			definition,
			{ ...definition, canvasId: 'input', requiresInput: true },
		];
		let failure = false;
		const source = observableValue<ICanvasDefinitionSource | undefined>(resources, undefined);
		const update = () =>
			source.set(
				{
					owner: owner('one'),
					listCanvases: async () => {
						if (failure) {
							throw new Error('Unsettled runtime');
						}
						return result;
					},
				},
				undefined,
			);
		const store = resources.add(new CanvasDefinitionStore(reader => source.read(reader), 'test', log));
		update();
		await settle();
		assert.deepEqual(store.definitions.get(), [definition]);
		result = undefined;
		update();
		await settle();
		assert.deepEqual(store.definitions.get(), [definition]);
		failure = true;
		update();
		await settle();
		assert.deepEqual(store.definitions.get(), [definition]);
		failure = false;
		result = [];
		update();
		await settle();
		assert.deepEqual(store.definitions.get(), []);
	});

	test('a new owner lists immediately and a late response cannot replace its definitions', async () => {
		using resources = new DisposableStore();
		const old = promiseWithResolvers<readonly ICanvasDefinition[]>();
		const source = observableValue<ICanvasDefinitionSource | undefined>(resources, {
			owner: owner('old'),
			listCanvases: () => old.promise,
		});
		const store = resources.add(new CanvasDefinitionStore(reader => source.read(reader), 'test', log));
		await settle();
		const latest = { ...definition, canvasId: 'new' };
		source.set({ owner: owner('new'), listCanvases: async () => [latest] }, undefined);
		await settle();
		assert.deepEqual(store.definitions.get(), [latest]);
		old.resolve([definition]);
		await settle();
		assert.deepEqual(store.definitions.get(), [latest]);
	});
});
