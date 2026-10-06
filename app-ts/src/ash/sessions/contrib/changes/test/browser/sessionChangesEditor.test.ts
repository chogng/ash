import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IChatService, type TurnChangeSetSummary } from '../../../../../workbench/services/chat/common/chatService.js';
import { EditorPaneVisibility } from '../../../../../workbench/browser/parts/editor/editorPane.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { SessionChangesEditor } from '../../browser/sessionChangesEditor.js';
import { URI } from '../../../../../base/common/uri.js';

test('a hidden Changes editor ignores a late ledger result and loads fresh content when shown', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using services = new InstantiationService();
	using configuration = new InMemoryConfigurationService();
	using context = new ContextKeyService();
	using changes = new Emitter<{ sessionId: string; threadId: string; }>();
	using ready = new Emitter<void>();
	const pending = new DeferredPromise<readonly TurnChangeSetSummary[]>();
	let requests = 0;
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextKeyService, context);
	services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
	services.registerInstance(ISessionsManagementService, { sessions: [{ sessionId: 'a' }] } as unknown as ISessionsManagementService);
	services.registerInstance(IChatService, {
		onDidUpdateTurnChanges: changes.event,
		onDidBecomeReady: ready.event,
		listTurnChanges: () => ++requests === 1 ? pending.p : Promise.resolve([]),
	} as unknown as IChatService);
	using pane = services.createInstance(SessionChangesEditor, {});
	pane.create(dom.window.document.body);
	await pane.setInput({ resource: URI.parse('ash-session-changes:/a?thread=a-thread') }, new AbortController().signal);
	pane.setVisible(EditorPaneVisibility.Visible);
	pane.setVisible(EditorPaneVisibility.Hidden);
	await pending.complete([{
		changeSetId: 'change-a', sessionId: 'a', threadId: 'a-thread', turnId: 'turn-a', repositoryId: 'repository-a',
		captureState: 'sealed', messageState: 'unconfigured', commitState: 'idle', committedPaths: [], revision: 1,
		statistics: { files: 1, additions: 1, deletions: 0 }, dependencies: [], externalDependencyPaths: [], warnings: [], conflictPaths: [],
	}]);
	await Promise.resolve();
	assert.equal(requests, 1);
	assert.equal(pane.getAccessibleContent(), 'Loading changes…');
	pane.setVisible(EditorPaneVisibility.Visible);
	await Promise.resolve();
	assert.equal(requests, 2);
	assert.equal(pane.getAccessibleContent(), 'No changes in this conversation.');
	pane.clearInput();
	changes.fire({ sessionId: 'a', threadId: 'a-thread' });
	assert.equal(requests, 2);
	dom.window.close();
});
