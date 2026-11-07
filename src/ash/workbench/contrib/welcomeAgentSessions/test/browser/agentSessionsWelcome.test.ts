import { DeferredPromise } from '../../../../../base/common/async.js';
import { ILifecycleService, LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { readFileSync } from 'node:fs';
import { setNlsMessages, resetNlsResolver } from '../../../../../nls.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { buildOpenSessionLinkUri } from '../../../../../platform/agentHost/common/openSessionLink.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, type IWorkspace } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../common/views.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { TestHostService } from '../../../../services/host/test/browser/testHostService.js';
import { TestWorkspaceService } from '../../../../services/configuration/test/common/testServices.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { createTestComponentServices } from '../../../../test/common/testEditorServices.js';
import type { IChatWidgetViewOptions, IQuickChatSession } from '../../../chat/browser/chat.js';
import { ChatViewPane } from '../../../chat/browser/widgetHosts/viewPane/chatViewPane.js';
import { getAgentSessionsWelcomePrefillKey, restoreTransferredChatConversation } from '../../../chat/browser/actions/chatTransfer.js';
import { AgentSessionsWelcomePage, AgentSessionsWelcomeInputSerializer } from '../../browser/agentSessionsWelcome.js';
import { AgentSessionsWelcomeInput } from '../../browser/agentSessionsWelcomeInput.js';

function fixture(workspace: IWorkspace = { id: 'empty', folders: [] }, lifecycle: Pick<ILifecycleService, 'phase' | 'when'> = { phase: LifecyclePhase.Restored, when: async () => { } }, workspaceTrusted = true) {
	const resources = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>');
	resources.add(toDisposable(() => dom.window.close()));
	const services = resources.add(createTestComponentServices(undefined, undefined, dom.window.document));
	const configuration = resources.add(new InMemoryConfigurationService());
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(ILifecycleService, lifecycle as ILifecycleService);
	services.registerInstance(IWorkspaceContextService, resources.add(new TestWorkspaceService(workspace)));
	services.registerInstance(IWorkspacesService, {
		onDidChangeRecentlyOpened: Event.None,
		getRecentlyOpened: async () => ({ workspaces: [{ folderUri: URI.file('/trusted') }, { folderUri: URI.file('/untrusted') }] }),
	} as unknown as IWorkspacesService);
	services.registerInstance(IWorkspaceTrustManagementService, {
		onDidChangeTrustedFolders: Event.None,
		workspaceTrustInitialized: Promise.resolve(),
		isWorkspaceTrusted: () => workspaceTrusted,
		getUriTrustInfo: async (uri: URI) => ({ trusted: uri.path === '/trusted', uri }),
	} as unknown as IWorkspaceTrustManagementService);
	const requests: unknown[] = [];
	let failOpen = false;
	const host = new TestHostService();
	host.openWindow = async (...args: unknown[]) => { requests.push(args); if (failOpen) { throw new Error('Cannot open target'); } };
	services.registerInstance(IHostService, host);
	services.registerInstance(ICommandService, { executeCommand: async () => { } } as unknown as ICommandService);
	services.registerInstance(INotificationService, { error(error: unknown) { throw error; } } as unknown as INotificationService);
	services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => '' } as unknown as IAccessibleViewService);
	let options: IChatWidgetViewOptions | undefined;
	let restored: unknown;
	const prefilled = new DeferredPromise<void>();
	let released = 0;
	let chatPartVisible = false;
	let chatCloseCount = 0;
	const draft = { mode: 'plan' as const, text: 'Review the selected project', contexts: [{ id: 'context', kind: 'file', name: 'notes.txt', content: 'Captured notes', reference: undefined }] };
	const view = Object.create(ChatViewPane.prototype) as ChatViewPane;
	view.createEmbeddedChat = (container, _title, value) => {
		options = value;
		const root = dom.window.document.createElement('div');
		container.append(root);
		return {
			widget: { domNode: root, focusInput() { }, captureDraft: async () => { throw new Error('The submitted draft has already left the live editor'); }, restoreDraft(value: unknown) { restored = value; void prefilled.complete(); } },
			onDidDispose: Event.None, setVisible() { }, reveal() { }, dispose() { released++; root.remove(); }, [Symbol.dispose]() { released++; root.remove(); },
		} as unknown as IQuickChatSession;
	};
	services.registerInstance(IViewsService, { openView: async () => view, isViewVisible: () => false, closeView() { chatCloseCount++; } } as unknown as IViewsService);
	services.registerInstance(IViewDescriptorService, { getViewContainerForView: () => ({ id: 'chat-container', location: ViewContainerLocation.AuxiliaryBar }) } as unknown as IViewDescriptorService);
	services.registerInstance(IPaneCompositePartService, { getPartId: () => 'auxiliarybar', getActivePaneComposite: () => undefined, getLastActivePaneCompositeId: () => 'chat-container' } as unknown as IPaneCompositePartService);
	services.registerInstance(IWorkbenchLayoutService, { isPartVisible: () => chatPartVisible } as unknown as IWorkbenchLayoutService);
	const page = resources.add(services.createInstance(AgentSessionsWelcomePage));
	page.create(dom.window.document.body);
	page.setVisible(true);
	return {
		page, requests, draft, configuration, services, whenPrefilled: prefilled.p,
		attachments: draft.contexts.map(context => ({ ...context, resolve: async () => ({ name: context.name, content: context.content }) })),
		storage: services.get(IStorageService), get options() { assert.ok(options); return options; }, get restored() { return restored; }, get released() { return released; },
		fail() { failOpen = true; },
		showChatPart() { chatPartVisible = true; },
		get chatCloseCount() { return chatCloseCount; },
		async open() { await page.setInput(new AgentSessionsWelcomeInput(), new AbortController().signal); },
		[Symbol.dispose]() { resources.dispose(); },
	};
}

test('Restoring Welcome preserves the saved Chat side bar visibility before its view mounts', async () => {
	for (const visible of [true, false]) {
		using f = fixture(undefined, { phase: LifecyclePhase.Ready, when: async () => { } });
		if (visible) { f.showChatPart(); }
		await f.open();
		assert.equal(f.chatCloseCount, visible ? 0 : 1);
	}
});

test('Welcome exposes only trusted targets and opens a chosen workspace with its captured draft', async () => {
	using f = fixture();
	await f.open();
	const delegate = f.options.workspacePickerDelegate!;
	assert.deepEqual(delegate.getWorkspaces().map(item => item.uri.path), ['/trusted']);
	delegate.setSelectedWorkspace(delegate.getWorkspaces()[0]);
	assert.equal(await f.options.submitHandler?.(f.draft.text, 'plan', f.attachments), true);
	const key = getAgentSessionsWelcomePrefillKey({ id: 'target', folders: [{ id: 'root', name: 'trusted', index: 0, uri: URI.file('/trusted') }] })!;
	assert.deepEqual(JSON.parse(f.storage.get(key, StorageScope.APPLICATION)!).payload.draft, JSON.parse(JSON.stringify(f.draft)));
	assert.equal(f.requests.length, 1);
});

test('Failed Welcome handoff rejects instead of falling through to a local send, and keeps the source draft', async () => {
	using f = fixture();
	await f.open();
	const delegate = f.options.workspacePickerDelegate!;
	assert.equal(await f.options.submitHandler?.('query', 'agent', []), false);
	delegate.setSelectedWorkspace(delegate.getWorkspaces()[0]);
	f.fail();
	await assert.rejects(f.options.submitHandler!(f.draft.text, 'agent', f.attachments), /Cannot open target/);
	assert.deepEqual(f.storage.keys(StorageScope.APPLICATION, StorageTarget.MACHINE).filter(key => key.startsWith('chat.welcomeViewPrefill:')), []);
	assert.equal(f.draft.text, 'Review the selected project');
});

for (const trusted of [true, false]) {
	test(`Conversation handoff opens the original conversation once when workspace trust is ${trusted}`, async () => {
		const uri = URI.file('/target');
		const workspace = { id: 'target', folders: [{ id: 'root', name: 'target', index: 0, uri }] };
		using f = fixture(workspace, undefined, trusted);
		const key = `chat.workspaceConversation:${uri.toString()}`;
		const link = buildOpenSessionLinkUri('original-session', 'original-thread', 'local');
		const opened: string[] = [];
		f.services.registerInstance(IOpenerService, { open: async (target: URI) => { opened.push(target.toString()); return true; } } as unknown as IOpenerService);
		f.storage.store(key, JSON.stringify({ link: link.toString(), expiresAt: Date.now() + 30_000 }), StorageScope.APPLICATION, StorageTarget.MACHINE);
		await f.services.invokeFunction(restoreTransferredChatConversation);
		await f.services.invokeFunction(restoreTransferredChatConversation);
		assert.deepEqual(opened, trusted ? [link.toString()] : []);
		assert.equal(f.storage.get(key, StorageScope.APPLICATION), undefined);
	});
}

test('Destination Welcome discards a handoff if the workspace is untrusted', async () => {
	const workspace = { id: 'target', folders: [{ id: 'root', name: 'untrusted', index: 0, uri: URI.file('/untrusted') }] };
	using f = fixture(workspace, undefined, false);
	const key = getAgentSessionsWelcomePrefillKey(workspace)!;
	f.storage.store(key, JSON.stringify({ timestamp: Date.now(), payload: { draft: f.draft } }), StorageScope.APPLICATION, StorageTarget.MACHINE);
	await f.open();
	assert.equal(f.restored, undefined);
	assert.equal(f.storage.get(key, StorageScope.APPLICATION), undefined);
});

test('Destination Welcome validates, consumes and prefills its own handoff without sending', async () => {
	const workspace = { id: 'target', folders: [{ id: 'root', name: 'trusted', index: 0, uri: URI.file('/trusted') }] };
	using f = fixture(workspace);
	const key = getAgentSessionsWelcomePrefillKey(workspace)!;
	f.storage.store(key, JSON.stringify({ timestamp: Date.now(), payload: { draft: f.draft } }), StorageScope.APPLICATION, StorageTarget.MACHINE);
	await f.open();
	assert.equal(f.options.workspacePickerDelegate, undefined);
	assert.deepEqual(f.restored, JSON.parse(JSON.stringify(f.draft)));
	assert.equal(f.storage.get(key, StorageScope.APPLICATION), undefined);
});

test('Welcome editor identity round trips without serializing another copy of the draft', () => {
	const serializer = new AgentSessionsWelcomeInputSerializer();
	using input = new AgentSessionsWelcomeInput();
	assert.deepEqual(serializer.serialize(input), { version: 1 });
	using restored = serializer.deserialize({ version: 1 });
	assert.equal(restored.resource.toString(), input.resource.toString());
	assert.throws(() => serializer.deserialize({ version: 2 }), /Invalid Welcome/);
});


test('Chinese Welcome uses the translated heading, region label and editor name', async () => {
	setNlsMessages('zh-CN', JSON.parse(readFileSync('extensions/language-pack-zh-cn/translations/workbench.json', 'utf8')));
	try {
		using f = fixture();
		await f.open();
		const content = f.page.getContainer()!;
		assert.equal(content.querySelector('h1')?.textContent, '你想处理什么工作？');
		assert.equal(content.getAttribute('aria-label'), 'Agent 会话欢迎页');
		using input = new AgentSessionsWelcomeInput();
		assert.equal(input.getName(), 'Agent 会话欢迎页');
	} finally { resetNlsResolver(); }
});


test('An inactive restored Welcome leaves its handoff available until startup can activate the destination', async () => {
	const ready = new DeferredPromise<void>();
	const lifecycle = { phase: LifecyclePhase.Ready, when: () => ready.p };
	const workspace = { id: 'restoring', folders: [{ id: 'root', name: 'trusted', index: 0, uri: URI.file('/trusted') }] };
	using f = fixture(workspace, lifecycle);
	const key = getAgentSessionsWelcomePrefillKey(workspace)!;
	const serialized = JSON.stringify({ timestamp: Date.now(), payload: { draft: f.draft } });
	f.storage.store(key, serialized, StorageScope.APPLICATION, StorageTarget.MACHINE);
	await f.open();
	assert.equal(f.restored, undefined);
	assert.equal(f.storage.get(key, StorageScope.APPLICATION), serialized);
	lifecycle.phase = LifecyclePhase.Restored;
	await ready.complete();
	await f.whenPrefilled;
	assert.deepEqual(f.restored, JSON.parse(JSON.stringify(f.draft)));
	assert.equal(f.storage.get(key, StorageScope.APPLICATION), undefined);
});
