import { registerTestComponentServices } from '../../../../../workbench/test/common/testEditorServices.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test, suite } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService, AccessibleViewType } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import { IChatService, type TurnChangeSetSummary } from '../../../../../workbench/services/chat/common/chatService.js';

import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { SessionChangesEditor } from '../../browser/sessionChangesEditor.js';
import { URI } from '../../../../../base/common/uri.js';
import '../../browser/changes.contribution.js';
import { ISessionChangesService } from '../../common/sessionChangesService.js';
import { SessionChangesService } from '../../browser/sessionChangesService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { emptyEditorServiceState } from '../../../../../workbench/test/common/testEditorService.js';
import { IDecorationsService, type IDecorationsProvider } from '../../../../../workbench/services/decorations/common/decorations.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Event } from '../../../../../base/common/event.js';

suite('Changes editor overlapping opens', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const cancelFirst of [false, true]) test(`a ${cancelFirst ? 'cancelled' : 'replaced'} open finishes without clearing a retry of the same input`, async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		using domOwner = toDisposable(() => dom.window.close());
		using services = registerTestComponentServices(new InstantiationService());
		using context = new ContextKeyService();
		services.registerInstance(IContextKeyService, context);
		using configuration = new InMemoryConfigurationService();
		services.registerInstance(IConfigurationService, configuration);
		using changes = new Emitter<{ sessionId: string; threadId: string; }>();
		const pending = new DeferredPromise<readonly TurnChangeSetSummary[]>();
		let requests = 0;
		const counts: (number | undefined)[] = [];
		services.registerInstance(ISessionChangesService, { setChangesCount: (_resource: URI, count: number | undefined) => { counts.push(count); } } as unknown as ISessionChangesService);
		services.registerInstance(ISessionsManagementService, { sessions: [{ sessionId: 'a' }] } as unknown as ISessionsManagementService);
		services.registerInstance(IChatService, {
			onDidUpdateTurnChanges: changes.event, onDidBecomeReady: Event.None,
			listTurnChanges: async () => ++requests === 1 ? pending.p : [],
		} as unknown as IChatService);
		services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
		using pane = services.createInstance(SessionChangesEditor, {});
		pane.create(dom.window.document.body);
		pane.setVisible(true);
		const input = { resource: URI.parse('ash-session-changes:/a?thread=a-thread') };
		const controller = new AbortController();
		const first = pane.setInput(input, controller.signal);
		const rejected = assert.rejects(first, { name: 'CancellationError' });
		if (cancelFirst) { controller.abort(); }
		await pane.setInput(input, new AbortController().signal);
		await rejected;
		controller.abort();
		await pending.error(new Error('Old ledger failed'));
		changes.fire({ sessionId: 'a', threadId: 'a-thread' });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(requests, 3);
		assert.equal(pane.getAccessibleContent(), 'No changes in this conversation.');
		assert.deepEqual(counts, [undefined, undefined, 0, undefined, 0]);
		pane.dispose();
		await assert.rejects(pane.setInput(input, new AbortController().signal), { name: 'CancellationError' });
		changes.fire({ sessionId: 'a', threadId: 'a-thread' });
		assert.equal(requests, 3);
	});
});

test('a hidden Changes editor ignores a late ledger result and loads fresh content when shown', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using services = new InstantiationService();
	services.registerSingleton(ISessionChangesService, () => services.createInstance(SessionChangesService));
	let decorations: IDecorationsProvider | undefined;
	services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor: async () => { } } as unknown as IEditorService);
	services.registerInstance(IDecorationsService, { registerDecorationsProvider: (provider: IDecorationsProvider) => { decorations = provider; return toDisposable(() => { }); } } as unknown as IDecorationsService);
	services.registerInstance(IQuickInputService, { input: async () => undefined } as unknown as IQuickInputService);
	services.registerInstance(IEditorGroupsService, { groups: [] } as unknown as IEditorGroupsService);
	using configuration = new InMemoryConfigurationService();
	using context = new ContextKeyService();
	using changes = new Emitter<{ sessionId: string; threadId: string; }>();
	using ready = new Emitter<void>();
	const pending = new DeferredPromise<readonly TurnChangeSetSummary[]>();
	let requests = 0;
	let failed = false;
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextKeyService, context);
	services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
	services.registerInstance(ISessionsManagementService, { sessions: [{ sessionId: 'a' }] } as unknown as ISessionsManagementService);
	services.registerInstance(IChatService, {
		onDidUpdateTurnChanges: changes.event,
		onDidBecomeReady: ready.event,
		listTurnChanges: () => ++requests === 1 ? pending.p : failed ? Promise.reject(new Error('Unavailable')) : Promise.resolve([]),
	} as unknown as IChatService);
	using pane = registerTestComponentServices(services).createInstance(SessionChangesEditor, {});
	pane.create(dom.window.document.body);
	const resource = URI.parse('ash-session-changes:/a?thread=a-thread');
	const changesService = services.get(ISessionChangesService);
	changesService.setChangesCount(resource, 5);
	await pane.setInput({ resource }, new AbortController().signal);
	pane.setVisible(true);
	assert.equal(await decorations!.provideDecorations(resource, CancellationToken.None), undefined);
	pane.setVisible(false);
	await pending.complete([{
		changeSetId: 'change-a', sessionId: 'a', threadId: 'a-thread', turnId: 'turn-a', repositoryId: 'repository-a',
		captureState: 'sealed', messageState: 'unconfigured', commitState: 'idle', committedPaths: [], revision: 1,
		statistics: { files: 1, additions: 1, deletions: 0 }, dependencies: [], externalDependencyPaths: [], warnings: [], conflictPaths: [],
	}]);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(requests, 1);
	assert.equal(pane.getAccessibleContent(), 'Loading changes…');
	pane.setVisible(true);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(requests, 2);
	assert.equal(pane.getAccessibleContent(), 'No changes in this conversation.');
	assert.equal((await decorations!.provideDecorations(resource, CancellationToken.None))?.letter, '0');
	services.registerInstance(IEditorPart, { activePane: pane } as unknown as IEditorPart);
	const accessibility = AccessibleViewRegistry.getImplementations().filter(provider => provider.name.startsWith('sessionsChangesEditor.'));
	assert.equal(accessibility.length, 2);
	for (const implementation of accessibility) {
		using provider = implementation.getProvider(services)!;
		if (implementation.type === AccessibleViewType.View) {
			assert.equal(provider.provideContent(), pane.getAccessibleContent());
		} else {
			assert.match(provider.provideContent(), /The file list and comparisons share this card/u);
		}
		provider.dispose();
		assert.equal(dom.window.document.activeElement, dom.window.document.querySelector('.ash-sessions-changes-editor'));
	}
	failed = true;
	ready.fire();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.match(pane.getAccessibleContent(), /Unavailable/u);
	assert.equal(await decorations!.provideDecorations(resource, CancellationToken.None), undefined);
	pane.clearInput();
	const cancelled = new AbortController();
	cancelled.abort();
	await assert.rejects(pane.setInput({ resource: URI.parse('ash-session-changes:/a?thread=a-thread') }, cancelled.signal), { name: 'CancellationError' });
	changes.fire({ sessionId: 'a', threadId: 'a-thread' });
	assert.equal(requests, 3);
	dom.window.close();
});
