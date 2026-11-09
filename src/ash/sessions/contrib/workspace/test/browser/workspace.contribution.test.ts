import { ISessionFolderTrustRetryService, SessionFolderTrustRetryService } from '../../../../services/workspace/browser/sessionFolderTrustRetryService.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { IAction } from '../../../../../base/common/actions.js';
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
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { CommandService } from '../../../../../workbench/services/commands/common/commandService.js';
import { NotificationService } from '../../../../../workbench/services/notification/common/notificationService.js';
import { createTestComponentServices } from '../../../../../workbench/test/common/testEditorServices.js';
import {
	AppServerRecoveryAvailableContext,
	ReconnectAppServerCommandId,
} from '../../../../../workbench/contrib/remote/browser/remoteActions.js';
import { Menus } from '../../../../browser/menus.js';
import '../../browser/workspace.contribution.js';

function actions(menu: IMenu): IAction[] {
	return menu.getActions().flatMap(([, group]) => group);
}

function createFixture() {
	const resources = new DisposableStore();
	resources.add(setARIAContainer(document.body));
	const services = resources.add(createTestComponentServices());
	const folderTrustRetry = new SessionFolderTrustRetryService();
	services.registerInstance(ISessionFolderTrustRetryService, folderTrustRetry);
	const contexts = resources.add(new ContextKeyService());
	services.registerInstance(IContextKeyService, contexts);
	const commands = resources.add(new CommandService(services));
	services.registerInstance(ICommandService, commands);
	const notifications = resources.add(services.createInstance(NotificationService));
	services.registerInstance(INotificationService, notifications);
	const recoveryChanges = resources.add(new Emitter<void>());
	let retries = 0;
	let reloads = 0;
	const recovery: IAppServerConnectionRecovery & {
		status: IAppServerConnectionRecovery['status'];
		phase: IAppServerConnectionRecovery['phase'];
		error: string | undefined;
	} = {
		status: 'idle',
		phase: 'connection',
		error: undefined,
		onDidChange: recoveryChanges.event,
		reconnect: async () => {
			retries++;
			recovery.status = 'recovering';
			recoveryChanges.fire();
		},
	};
	services.registerInstance(IAppServerApi, {
		isAvailable: true,
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
		folderTrustRetry,
		menu,
		contexts,
		host,
		notifications,
		get effects() {
			return { retries, reloads };
		},
		setRecovery(value: IAppServerConnectionRecovery['status'], phase: IAppServerConnectionRecovery['phase'] = 'connection') {
			recovery.status = value;
			recovery.phase = phase;
			recovery.error = value === 'unavailable' ? 'fixture authorization expired' : undefined;
			recoveryChanges.fire();
		},
		dispose,
		[Symbol.dispose]: dispose,
	};
}

for (const locale of ['en', 'zh-CN']) {
	test(`Agent workspace status shows recovery and explicit folder trust actions (${locale})`, async () => {
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
			assert.deepEqual(actions(fixture.menu), []);
			fixture.setRecovery('recovering');
			assert.equal(
				actions(fixture.menu)[0]!.label,
				locale === 'en' ? 'Reconnecting to the Agent Host…' : '正在重新连接到 Agent Host…',
			);
			fixture.setRecovery('failed');
			const reconnect = actions(fixture.menu)[0]!;
			assert.equal(reconnect.label, locale === 'en' ? 'Reconnect Agent Host' : '重新连接 Agent 主机');
			assert.equal(reconnect.tooltip, locale === 'en' ? 'Could not reconnect to the Agent Host. Try again.' : '无法重新连接 Agent Host。请重试。');
			assert.equal(reconnect.id, ReconnectAppServerCommandId);
			await reconnect.run();
			assert.equal(fixture.effects.retries, 1);
			fixture.setRecovery('failed', 'workspace');
			assert.equal(actions(fixture.menu)[0]!.label, locale === 'en' ? 'Retry workspace restore' : '重试恢复工作区');
			const trustLabel = locale === 'en' ? 'Trust this workspace' : '信任此工作区';
			fixture.setRecovery('recovering', 'workspaceTrust');
			assert.equal(actions(fixture.menu)[0]!.label, trustLabel);
			fixture.setRecovery('failed', 'workspaceTrust');
			const trust = actions(fixture.menu)[0]!;
			assert.equal(trust.label, trustLabel);
			assert.equal(trust.tooltip, trustLabel);
			await trust.run();
			assert.equal(fixture.effects.retries, 2);
			let folderRetries = 0;
			using folderRetry = fixture.folderTrustRetry.offer({
				path: '/ash-docs',
				run: async () => { folderRetries++; },
			});
			const retry = actions(fixture.menu)[0]!;
			assert.deepEqual(actions(fixture.menu).map(item => item.id), [retry.id]);
			assert.equal(retry.label, locale === 'en' ? 'Retry trust for /ash-docs' : '重新授权 /ash-docs');
			assert.equal(retry.tooltip, retry.label);
			await retry.run();
			assert.equal(folderRetries, 1);
			assert.equal(fixture.effects.retries, 2);
			folderRetry.dispose();
			assert.equal(actions(fixture.menu)[0]!.label, trustLabel);
			assert.equal(fixture.notifications.model.getNotifications().length, 0);
			fixture.setRecovery('idle');
			assert.deepEqual(actions(fixture.menu), []);
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
