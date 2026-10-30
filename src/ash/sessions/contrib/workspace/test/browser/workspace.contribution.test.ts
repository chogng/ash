import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { URI } from '../../../../../base/common/uri.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import {
	IAppServerApi,
	type IAppServerConnectionRecovery,
} from '../../../../../platform/agentHost/common/appServerApi.js';
import { type IMenu } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import {
	IWorkspaceTrustManagementService,
	type IWorkspaceTrustInfo,
} from '../../../../../platform/workspace/common/workspaceTrust.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { CommandService } from '../../../../../workbench/services/commands/common/commandService.js';
import { TestWorkspaceService } from '../../../../../workbench/services/configuration/test/common/testServices.js';
import { NotificationService } from '../../../../../workbench/services/notification/common/notificationService.js';
import { createTestComponentServices } from '../../../../../workbench/test/common/testEditorServices.js';
import {
	AppServerRecoveryAvailableContext,
	ReconnectAppServerCommandId,
} from '../../../../../workbench/contrib/remote/browser/remoteActions.js';
import { MANAGE_TRUST_COMMAND_ID } from '../../../../../workbench/contrib/workspace/common/workspace.js';
import { Menus } from '../../../../browser/menus.js';
import { SessionsWorkspaceModeContext } from '../../../../common/contextkeys.js';
import '../../browser/workspace.contribution.js';

function actions(menu: IMenu): IAction[] {
	return menu.getActions().flatMap(([, group]) => group);
}

function waitForMenu(menu: IMenu, predicate: (items: IAction[]) => boolean): Promise<void> {
	if (predicate(actions(menu))) return Promise.resolve();
	return new Promise(resolve => {
		const listener = menu.onDidChange(() => {
			if (!predicate(actions(menu))) return;
			listener.dispose();
			resolve();
		});
	});
}

function createFixture() {
	const resources = new DisposableStore();
	resources.add(setARIAContainer(document.body));
	const services = resources.add(createTestComponentServices());
	const contexts = resources.add(new ContextKeyService());
	services.registerInstance(IContextKeyService, contexts);
	const commands = resources.add(new CommandService(services));
	services.registerInstance(ICommandService, commands);
	const notifications = resources.add(services.createInstance(NotificationService));
	services.registerInstance(INotificationService, notifications);
	const workspace = resources.add(
		new TestWorkspaceService({
			id: 'window-workspace',
			folders: [{ id: 'fixture', uri: URI.file('/fixture'), name: 'Fixture', index: 0 }],
		}),
	);
	services.registerInstance(IWorkspaceContextService, workspace);
	const permissionChanges = resources.add(new Emitter<void>());
	let permission: IWorkspaceTrustInfo = { isTrusted: false, isReadOnly: true };
	services.registerInstance(IWorkspaceTrustManagementService, {
		onDidChangeTrust: Event.None,
		onDidChangeTrustedFolders: permissionChanges.event,
		workspaceResolved: Promise.resolve(),
		workspaceTrustInitialized: Promise.resolve(),
		isWorkspaceTrusted: () => permission.isTrusted,
		canSetWorkspaceTrust: () => true,
		resolveWorkspaceTrust: async () => { },
		getWorkspaceTrustInfo: async () => permission,
		setWorkspaceTrust: async trusted => {
			permission = { isTrusted: trusted, isReadOnly: !trusted };
			permissionChanges.fire();
		},
		setUrisTrust: async () => {
			throw new Error('Unexpected permission mutation');
		},
		getUriTrustInfo: async uri => ({ uri, trusted: permission.isTrusted, permissions: undefined }),
		addWorkspaceTrustTransitionParticipant: () => toDisposable(() => { }),
	});
	const recoveryChanges = resources.add(new Emitter<void>());
	let retries = 0;
	let reloads = 0;
	let managed = 0;
	const recovery: IAppServerConnectionRecovery & {
		status: IAppServerConnectionRecovery['status'];
		error: string | undefined;
	} = {
		status: 'idle',
		error: undefined,
		onDidChange: recoveryChanges.event,
		reconnect: async () => {
			retries++;
			recovery.status = 'recovering';
			recoveryChanges.fire();
		},
	};
	services.registerInstance(IAppServerApi, {
		connectionGeneration: 1,
		getConnectionState: async () => 'ready',
		getSlashCommands: async () => [],
		onConnectionState: () => toDisposable(() => { }),
		recovery,
	});
	resources.add(
		CommandsRegistry.register('workbench.action.reloadWindow', () => {
			reloads++;
		}),
	);
	resources.add(
		CommandsRegistry.register(MANAGE_TRUST_COMMAND_ID, () => {
			managed++;
		}),
	);
	const mode = SessionsWorkspaceModeContext.bindTo(contexts);
	mode.set('code');
	const menu = resources.add(new MenuService(commands, contexts).createMenu(Menus.TitleBarRightLayout));
	const host = resources.add(
		WorkbenchContributionsRegistry.createHost(
			services,
			error => {
				throw error;
			},
			['sessions.contrib.workspaceStatus'],
		),
	);
	host.advance(WorkbenchPhase.BlockRestore);
	const dispose = (): void => {
		host.dispose();
		resources.dispose();
	};
	return {
		menu,
		mode,
		contexts,
		host,
		notifications,
		get effects() {
			return { retries, reloads, managed };
		},
		setPermission(value: IWorkspaceTrustInfo) {
			permission = value;
			permissionChanges.fire();
		},
		setRecovery(value: IAppServerConnectionRecovery['status']) {
			recovery.status = value;
			recovery.error = value === 'unavailable' ? 'fixture authorization expired' : undefined;
			recoveryChanges.fire();
		},
		dispose,
		[Symbol.dispose]: dispose,
	};
}

for (const locale of ['en', 'zh-CN']) {
	test(`Agent workspace status scopes permissions and keeps recovery actions available (${locale})`, async () => {
		if (locale === 'zh-CN') {
			const sessions = JSON.parse(
				readFileSync('extensions/language-pack-zh-cn/translations/sessions.json', 'utf8'),
			);
			const workbench = JSON.parse(
				readFileSync('extensions/language-pack-zh-cn/translations/workbench.json', 'utf8'),
			);
			setNlsMessages(locale, { ash: { ...workbench.ash, ...sessions.ash } });
		}
		try {
			using fixture = createFixture();
			await waitForMenu(fixture.menu, items => items.some(item => item.id === MANAGE_TRUST_COMMAND_ID));
			const permission = actions(fixture.menu).find(item => item.id === MANAGE_TRUST_COMMAND_ID)!;
			assert.equal(permission.label, locale === 'en' ? 'Read-only workspace: Fixture' : '只读工作区：Fixture');
			assert.match(permission.tooltip, /file:\/\/\/fixture/);
			await permission.run();
			assert.equal(fixture.effects.managed, 1);
			fixture.mode.set('chat');
			assert.deepEqual(actions(fixture.menu), []);
			fixture.setRecovery('recovering');
			assert.equal(
				actions(fixture.menu)[0]!.label,
				locale === 'en' ? 'Reconnecting to the Agent Host…' : '正在重新连接到 Agent Host…',
			);
			fixture.setRecovery('failed');
			const reconnect = actions(fixture.menu)[0]!;
			assert.equal(reconnect.label, locale === 'en' ? 'Reconnect Agent Host' : '重新连接 Agent 主机');
			assert.equal(reconnect.id, ReconnectAppServerCommandId);
			await reconnect.run();
			assert.equal(fixture.effects.retries, 1);
			assert.equal(fixture.notifications.model.getNotifications().length, 0);
			fixture.setRecovery('idle');
			assert.deepEqual(actions(fixture.menu), []);
			fixture.mode.set('code');
			fixture.setPermission({ isTrusted: true, isReadOnly: false });
			await waitForMenu(fixture.menu, items => items.length === 0);
			assert.equal(
				fixture.contexts.contextMatchesRules(AppServerRecoveryAvailableContext.isEqualTo(true)),
				false,
			);
		} finally {
			resetNlsResolver();
		}
	});
}

test('Agent terminal connection failure offers one global reload action and releases its presentation', async () => {
	using fixture = createFixture();
	await waitForMenu(fixture.menu, items => items.some(item => item.id === MANAGE_TRUST_COMMAND_ID));
	fixture.mode.set('chat');
	fixture.setRecovery('unavailable');
	const notification = fixture.notifications.model.getNotifications()[0]!;
	assert.equal(fixture.notifications.model.getNotifications().length, 1);
	assert.match(notification.message, /fixture authorization expired/);
	assert.equal(notification.sticky, true);
	assert.equal(actions(fixture.menu)[0]!.label, 'Reload Agent Window');
	await notification.actions!.primary![0]!.run();
	assert.equal(fixture.effects.reloads, 1);
	fixture.setRecovery('unavailable');
	assert.equal(fixture.notifications.model.getNotifications()[0], notification);
	fixture.host.dispose();
	assert.equal(fixture.notifications.model.getNotifications().length, 0);
	assert.deepEqual(actions(fixture.menu), []);
});
