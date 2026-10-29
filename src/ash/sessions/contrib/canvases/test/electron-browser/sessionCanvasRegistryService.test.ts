import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { observableValue, constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import type { ICanvasContext, ICanvasContextService, ICanvasDefinition, ICanvasService } from '../../../../../workbench/contrib/canvases/common/canvas.js';
import { SessionCanvasRegistryService } from '../../electron-browser/sessionCanvasService.js';
import type { ISessionsService, SessionsViewSelection } from '../../../../services/sessions/browser/sessionsService.js';

suite('Session Canvas registry targeting', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('clears stale definitions on focus changes and never dispatches a peer or remote definition', async () => {
		using lifetime = new DisposableStore();
		const changed = lifetime.add(new Emitter<void>());
		const definitionsChanged = lifetime.add(new Emitter<void>());
		const services = lifetime.add(new InstantiationService());
		services.registerInstance(ILogService, new NullLoggerService());
		const stale = promiseWithResolvers<readonly ICanvasDefinition[]>();
		const definition: ICanvasDefinition = {
			extensionId: 'fixture',
			canvasId: 'board',
			extensionSource: 'plugin',
			displayName: 'Board',
			description: '',
			requiresInput: false,
		};
		const opened: string[] = [];
		const owner = (thread: string, providerId = 'local-agent-host') => ({
			providerId,
			session: URI.parse('ash-session:/one'),
			chat: URI.parse('ash-thread:/' + thread),
		});
		const contexts = observableValue<readonly ICanvasContext[]>(
			'test',
			['first', 'second'].map(thread => ({
				owner: owner(thread),
				canvases: constObservable([]),
				definitionProvider: {
					onDidChangeDefinitions: definitionsChanged.event,
					listCanvases: () => (thread === 'first' ? stale.promise : Promise.resolve([definition, { ...definition, canvasId: 'requires-input', requiresInput: true }])),
					openCanvas: async () => {
						opened.push(thread);
					},
				},
			})),
		);
		const selection = (thread: string, providerId = 'local-agent-host') =>
			({
				kind: 'session',
				active: { session: { sessionId: 'one', providerId }, threadId: thread },
			}) as SessionsViewSelection;
		let activeSelection = selection('first');
		const registry = lifetime.add(
			new SessionCanvasRegistryService(
				{
					onDidChange: changed.event,
					get activeSelection() {
						return activeSelection;
					},
				} as ISessionsService,
				{ contexts, isOwnerVisible: () => true } as unknown as ICanvasContextService,
				{ enabled: constObservable(true) } as unknown as ICanvasService,
				services,
			),
		);
		await settle();
		activeSelection = selection('second');
		changed.fire();
		await settle();
		assert.deepEqual(registry.availableCanvases.get(), [definition]);
		stale.resolve([{ ...definition, canvasId: 'old' }]);
		await settle();
		assert.deepEqual(registry.availableCanvases.get(), [definition]);
		await registry.openCanvas(definition);
		assert.deepEqual(opened, ['second']);
		activeSelection = selection('second', 'remote-provider');
		changed.fire();
		await settle();
		assert.deepEqual(registry.availableCanvases.get(), []);
		await assert.rejects(registry.openCanvas(definition));
		assert.deepEqual(opened, ['second']);
	});
});

function settle(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}
