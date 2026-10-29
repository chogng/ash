import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import type { IChatWidgetService } from '../../../chat/browser/chat.js';
import type { IChatService } from '../../../../services/chat/common/chatService.js';
import type { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { IAgentSessionService } from '../../../../../platform/agentHost/common/agentService.js';
import type { SessionCatalogReadResult } from '../../../../../platform/agentHost/common/agent.js';
import type { IAgentHostCanvasCollection } from '../../common/agentHostCanvas.js';
import type { ICanvasOwner } from '../../common/canvas.js';
import { EditorCanvasContextService } from '../../electron-browser/editorCanvasContextService.js';

suite('IDE Canvas conversation contexts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const active: SessionCatalogReadResult = {
		session: {
			sessionId: 'source',
			title: 'Source',
			manager: { status: 'idle', statusChangedAtUnixMs: 0 },
			status: 'active',
			threads: [{ threadId: 'one', title: 'One', status: 'active' }],
		},
	};
	const settle = () => new Promise<void>(resolve => setImmediate(resolve));

	test('widget changes preserve background owners and only an authoritative catalog removal retires them', async () => {
		using f = fixture();
		const first = f.context.contexts.get()[0]!;
		f.widget.threadId = 'two';
		f.widgetsChanged.fire();
		assert.equal(f.context.contexts.get().length, 2);
		assert.equal(f.context.isOwnerVisible(first.owner), false);
		f.read = async () => {
			throw new Error('connection unavailable');
		};
		f.sessionChanged.fire({ sessionId: 'source' });
		await settle();
		assert.deepEqual(f.removed, []);
		f.read = async () => ({ session: null });
		f.sessionChanged.fire({ sessionId: 'source' });
		await settle();
		assert.equal(f.removed.length, 2);
		assert.deepEqual(f.context.contexts.get(), []);
	});

	test('a late catalog response cannot remove an owner confirmed by a newer read', async () => {
		using f = fixture();
		f.context.contexts.get();
		const old = promiseWithResolvers<SessionCatalogReadResult>();
		f.read = () => old.promise;
		f.sessionChanged.fire({ sessionId: 'source' });
		f.read = async () => active;
		f.sessionChanged.fire({ sessionId: 'source' });
		await settle();
		old.resolve({ session: null });
		await settle();
		assert.equal(f.context.contexts.get().length, 1);
		assert.deepEqual(f.removed, []);
	});

	function fixture() {
		const lifetime = new DisposableStore();
		const widgetsChanged = lifetime.add(new Emitter<void>());
		const sessionChanged = lifetime.add(new Emitter<{ sessionId: string }>());
		const widget = { sessionId: 'source', threadId: 'one', visible: true };
		const removed: ICanvasOwner[] = [];
		const f = {
			widget,
			widgetsChanged,
			sessionChanged,
			removed,
			read: async (): Promise<SessionCatalogReadResult> => active,
			[Symbol.dispose]: () => lifetime.dispose(),
		};
		const context = lifetime.add(
			new EditorCanvasContextService(
				{
					getAllWidgets: () => [widget],
					onDidChangeWidgets: widgetsChanged.event,
				} as unknown as IChatWidgetService,
				{} as IEditorPart,
				{ getValue: () => undefined, onDidChangeConfiguration: Event.None } as unknown as IConfigurationService,
				{
					createContext: (owner: ICanvasOwner) => ({ owner, canvases: constObservable([]) }),
					removeOwner: (owner: ICanvasOwner) => removed.push(owner),
				} as unknown as IAgentHostCanvasCollection,
				{ readCatalog: () => f.read() } as unknown as IAgentSessionService,
				{ onDidChangeSession: sessionChanged.event, onDidBecomeReady: Event.None } as unknown as IChatService,
			),
		);
		return Object.assign(f, { context });
	}
});
