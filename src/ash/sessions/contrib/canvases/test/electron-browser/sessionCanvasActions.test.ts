import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import type { ICanvas } from '../../../../../workbench/common/canvasReference.js';
import { ICanvasContextService, ICanvasService, getCanvasDefinitionInstanceId, type ICanvasDefinition } from '../../../../../workbench/contrib/canvases/common/canvas.js';
import { IChatSessionNavigationService } from '../../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { CommandService } from '../../../../../workbench/services/commands/common/commandService.js';
import { OPEN_SESSION_CANVAS_COMMAND_ID, REOPEN_SESSION_CANVAS_COMMAND_ID, registerSessionCanvasActions } from '../../electron-browser/sessionCanvasActions.js';

suite('Sessions Canvas actions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the Activity Bar and open picker exclude a Canvas shown in its fixed page', async () => {
		using resources = new DisposableStore();
		const services = resources.add(new InstantiationService());
		const accepted = resources.add(new Emitter<void>());
		const hidden = resources.add(new Emitter<void>());
		const picker = {
			items: [] as readonly IQuickPickItem[],
			selectedItems: [] as readonly IQuickPickItem[],
			activeItems: [],
			onDidAccept: accepted.event,
			onDidHide: hidden.event,
			show() { },
			hide: () => hidden.fire(),
			[Symbol.dispose]() { },
		};
		services.registerInstance(ILogService, { error: (error: unknown) => assert.fail(String(error)) } as unknown as ILogService);
		services.registerInstance(IQuickInputService, { createQuickPick: () => picker } as unknown as IQuickInputService);
		services.registerInstance(IChatSessionNavigationService, {
			getActiveConversation: () => undefined,
		} as IChatSessionNavigationService);

		const owner = { providerId: 'local-agent-host', session: URI.parse('ash-session:/session'), chat: URI.parse('ash-thread:/chat') };
		const definition: ICanvasDefinition = {
			extensionId: 'test.canvases', canvasId: 'board', extensionSource: 'user', displayName: 'Board definition', description: '', requiresInput: false,
		};
		const board: ICanvas = {
			resource: URI.parse('agent-host-canvas:/board'), title: 'Board',
			instanceId: getCanvasDefinitionInstanceId(definition), source: URI.parse('https://example.test/board'),
		};
		const preview: ICanvas = { ...board, resource: URI.parse('agent-host-canvas:/preview'), title: 'Preview', instanceId: 'preview' };
		const live = observableValue<readonly ICanvas[]>('live canvases', [board, preview]);
		const shownInFixedPage = observableValue<URI | undefined>('fixed Canvas', board.resource);
		const contexts: ICanvasContextService = {
			contexts: constObservable([{
				owner, canvases: live, definitionProvider: {
					onDidChangeDefinitions: Event.None,
					listCanvases: async () => [definition],
					openCanvas: async () => assert.fail('The fixed Canvas must not be offered as a new definition'),
				},
			}]),
			onDidChangeVisibility: Event.None, onDidRemoveOwner: Event.None, isOwnerVisible: () => true,
			getContext: () => undefined, getFrontendSessionResource: () => undefined, getEditorGroup: () => undefined,
		};
		const revealed: URI[] = [];
		const canvases = {
			enabled: constObservable(true), reopenableCanvases: constObservable([]),
			isOwnerPresentable: (reference, reader) => reference.canvas !== shownInFixedPage.read(reader),
			revealCanvas: async reference => { revealed.push(reference.canvas); },
		} satisfies Pick<ICanvasService, 'enabled' | 'reopenableCanvases' | 'isOwnerPresentable' | 'revealCanvas'>;
		const service = canvases as unknown as ICanvasService;
		services.registerInstance(ICanvasContextService, contexts);
		services.registerInstance(ICanvasService, service);
		resources.add(registerSessionCanvasActions(service, {
			availableCanvases: constObservable([definition]),
			getActiveOwner: () => owner,
			openCanvas: async () => assert.fail('Unexpected definition open'),
		}, contexts));
		const commands = resources.add(new CommandService(services));

		const opening = commands.executeCommand(OPEN_SESSION_CANVAS_COMMAND_ID);
		await new Promise<void>(resolve => setImmediate(resolve));
		picker.hide();
		await opening;
		assert.deepEqual(revealed, [preview.resource], 'The shortcut reveals the sole presentable target');

		live.set([board], undefined);
		const picking = commands.executeCommand(REOPEN_SESSION_CANVAS_COMMAND_ID);
		await new Promise<void>(resolve => setImmediate(resolve));
		try {
			assert.equal(picker.items.length, 0, 'The fixed Canvas is absent from both live and new choices');
			shownInFixedPage.set(undefined, undefined);
			assert.deepEqual(picker.items.map(item => item.label), ['Board']);
			const stale = picker.items[0]!;
			shownInFixedPage.set(board.resource, undefined);
			assert.equal(picker.items.length, 0);
			picker.selectedItems = [stale];
			accepted.fire();
		} finally {
			picker.hide();
			await picking;
		}
		assert.deepEqual(revealed, [preview.resource], 'Accepting an outdated choice cannot reveal the fixed Canvas');
	});
});
