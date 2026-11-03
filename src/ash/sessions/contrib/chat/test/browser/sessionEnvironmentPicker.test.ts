import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { constObservable } from '../../../../../base/common/observable.js';
import type { ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ActionWidgetService, IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { ActionListItemKind } from '../../../../../platform/actionWidget/browser/actionList.js';
import { IRemoteAgentHostService } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IRemoteConnectionService } from '../../../../../platform/remote/common/remoteConnectionService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import type { IChatWidgetModel } from '../../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { IAgentConnection } from '../../../../../platform/agentHost/common/agentService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../common/agentHostSessionsProvider.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { SessionEnvironmentPicker } from '../../browser/sessionEnvironmentPicker.js';

test('Environment discovery yields to an existing or newer workspace menu and can be retried', async () => {
	using lifetime = new DisposableStore();
	const dom = new JSDOM('<body><div id="footer"></div><button id="workspace">Workspace</button></body>');
	lifetime.add(toDisposable(() => dom.window.close()));
	const document = dom.window.document;
	const footer = document.querySelector<HTMLElement>('#footer')!;
	const workspace = document.querySelector<HTMLButtonElement>('#workspace')!;
	const services = lifetime.add(new InstantiationService());
	services.registerInstance(IContextViewService, lifetime.add(new BrowserContextViewService(document.body)));
	services.registerInstance(IConfigurationService, lifetime.add(new InMemoryConfigurationService()));
	const menus = lifetime.add(services.createInstance(ActionWidgetService));
	services.registerInstance(IActionWidgetService, menus);
	const discovery = new DeferredPromise<string[]>();
	let discoveries = 0;
	services.registerInstance(IRemoteAgentHostService, {
		isAvailable: true,
		connections: [],
		listWSLDistros: () => { discoveries++; return discovery.p; },
	} as unknown as IRemoteAgentHostService);
	services.registerInstance(IRemoteConnectionService, { available: false } as IRemoteConnectionService);
	const commands: unknown[][] = [];
	services.registerInstance(ICommandService, {
		async executeCommand(...args: unknown[]) { commands.push(args); return false; },
	} as unknown as ICommandService);
	services.registerInstance(INotificationService, { error: (error: unknown) => assert.fail(String(error)) } as unknown as INotificationService);
	services.registerInstance(IStorageService, { keys: () => [] } as unknown as IStorageService);
	services.registerInstance(IAgentConnection, {} as IAgentConnection);
	services.registerInstance(ILayoutService, {} as ILayoutService);
	services.registerInstance(IFileDialogService, {} as IFileDialogService);
	services.registerInstance(IWorkspacesService, {} as IWorkspacesService);
	const draft = { untitledSessionId: 'draft', providerId: LOCAL_AGENT_HOST_PROVIDER_ID, workspace: { type: 'current' } };
	services.registerInstance(ISessionsManagementService, {
		untitledSessions: [draft], onDidChange: Event.None,
	} as unknown as ISessionsManagementService);
	const providers: ISessionsProvider[] = [];
	services.registerInstance(ISessionsProvidersService, {
		onDidChangeProviders: Event.None, getProviders: () => providers, getProvider: () => undefined,
	} as unknown as ISessionsProvidersService);
	const model = { untitledSessionId: draft.untitledSessionId, inputState: { phase: 'ready' }, onDidChange: Event.None };
	lifetime.add(services.createInstance(SessionEnvironmentPicker, footer, model as unknown as IChatWidgetModel, async () => { }));
	const trigger = footer.querySelector<HTMLButtonElement>('button')!;
	const openWorkspace = () => {
		workspace.focus();
		menus.show('testWorkspace', false, [{ kind: ActionListItemKind.Action, label: 'Open Folder', item: 'folder' }], {
			onHide: () => { }, onSelect: () => { },
		}, workspace);
	};

	openWorkspace();
	trigger.click();
	assert.equal(discoveries, 0);
	assert.equal(trigger.getAttribute('aria-expanded'), 'false');
	menus.hide();

	trigger.click();
	assert.equal(discoveries, 1);
	openWorkspace();
	await discovery.complete(['Ubuntu']);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(trigger.getAttribute('aria-expanded'), 'false');
	assert.ok(document.querySelector('[aria-label="Open Folder"]'));
	menus.hide();

	providers.push({
		id: 'ssh:devbox', label: 'devbox', connectionStatus: constObservable('connected'),
		currentWorkspace: () => ({ type: 'ssh', host: 'devbox', root: '/workspace' }),
	} as ISessionsProvider);
	trigger.focus();
	trigger.click();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(discoveries, 2);
	assert.equal(trigger.getAttribute('aria-expanded'), 'true');
	assert.ok(document.querySelector('[aria-label="WSL: Ubuntu"]'));
	assert.ok(document.querySelector('[aria-label="Cloud"]:disabled'));
	assert.ok(document.querySelector('[aria-label="New Environment"]'));
	assert.equal(document.querySelector('[aria-label="Add Remote…"]'), null);
	const remote = document.querySelector<HTMLElement>('[aria-label="Remote"]');
	assert.ok(remote);
	const host = document.querySelector<HTMLElement>('[aria-label="devbox"]');
	assert.ok(host);
	assert.equal(host.closest('[role="menu"]'), remote.closest('[role="menu"]'));
	assert.ok(host.compareDocumentPosition(remote) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
	assert.equal(remote.getAttribute('aria-haspopup'), 'menu');
	remote.focus();
	remote.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
	assert.equal(remote.getAttribute('aria-expanded'), 'true');
	assert.ok(document.querySelector('[aria-label="Cloud"]'));
	assert.ok(document.querySelector('[aria-label="SSH"]'));
	const tunnel = document.querySelector<HTMLButtonElement>('[aria-label="Ash Tunnel"]');
	assert.ok(tunnel);
	assert.equal(document.activeElement, tunnel);

	tunnel.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
	assert.equal(remote.getAttribute('aria-expanded'), 'false');
	assert.equal(trigger.getAttribute('aria-expanded'), 'true');
	assert.equal(document.activeElement, remote);

	remote.click();
	assert.equal(remote.getAttribute('aria-expanded'), 'true');
	const reopenedTunnel = document.querySelector<HTMLButtonElement>('[aria-label="Ash Tunnel"]');
	assert.ok(reopenedTunnel);
	reopenedTunnel.click();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(commands, [['sessions.action.newRemoteEnvironment', 'tunnel']]);
	assert.equal(trigger.getAttribute('aria-expanded'), 'false');

	trigger.focus();
	trigger.click();
	await new Promise<void>(resolve => setImmediate(resolve));
	menus.hide();
	assert.equal(trigger.getAttribute('aria-expanded'), 'false');
	assert.equal(document.activeElement, trigger);
});
