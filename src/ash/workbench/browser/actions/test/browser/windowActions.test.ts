import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { DialogResult, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import type { RemoteAgentConnection } from '../../../../../platform/remote/common/remoteAgentApi.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { DialogService } from '../../../../services/dialogs/common/dialogService.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { IAppServerRemoteAgentService } from '../../../../services/remote/common/appServerRemoteAgentService.js';
import { ShowAboutDialogAction } from '../../windowActions.js';

const sshConnection: RemoteAgentConnection = { kind: 'ssh', generation: 1, authority: 'ssh+private-alias', host: 'private-alias' };

async function openAbout(
	connection: RemoteAgentConnection | undefined,
	connectionState: IAppServerRemoteAgentService['connectionState'],
	operatingSystem: OperatingSystem | undefined,
): Promise<{ title: string | undefined; details: string[]; }> {
	using registration = registerAction2(ShowAboutDialogAction);
	using services = new InstantiationService();
	using dialogs = new DialogService();
	services.registerInstance(IDialogService, dialogs);
	services.registerInstance(IAppServerRemoteAgentService, {
		connection,
		connectionState,
		onDidChangeConnectionState: Event.None,
		onDidChangeConnection: Event.None,
		reconnect: () => assert.fail('About must not reconnect'),
		rollbackRuntime: () => assert.fail('About must not change the runtime'),
	});
	services.registerInstance(IAppServerApi, {
		isAvailable: true,
		connectionGeneration: 1,
		operatingSystem,
		getConnectionState: () => assert.fail('About must use cached connection state'),
		getSlashCommands: () => assert.fail('About must not read slash commands'),
		onConnectionState: () => assert.fail('About must not subscribe'),
	});
	using commands = new CommandService(services);
	const command = commands.executeCommand('workbench.action.showAboutDialog');
	const item = dialogs.model.dialogs[0];
	item?.close({ button: DialogResult.Primary });
	await command;
	assert.ok(item);
	assert.equal(item.request.kind, 'message');
	return { title: item.request.title, details: (item.request.detail ?? '').split('\n') };
}

test('About Ash shows only the version for local and unknown connections', async () => {
	for (const connection of [{ kind: 'local', generation: 1 }, undefined] as const) {
		const { title, details } = await openAbout(connection, 'connected', OperatingSystem.Macintosh);
		assert.equal(title, 'About Ash');
		assert.match(details[0]!, /^Version \d+\.\d+\.\d+/);
		assert.equal(details.length, 1);
	}
});

test('About Ash shows only the SSH type and initialized OS for a connected remote', async () => {
	const { details } = await openAbout(sshConnection, 'connected', OperatingSystem.Linux);
	assert.deepEqual(details.slice(1), ['Remote connection: SSH', 'Remote OS: Linux']);
});

test('About Ash keeps the SSH type while disconnected or OS metadata is unavailable', async () => {
	const disconnected = await openAbout(sshConnection, 'disconnected', OperatingSystem.Linux);
	const missingOS = await openAbout(sshConnection, 'connected', undefined);
	assert.deepEqual(disconnected.details.slice(1), ['Remote connection: SSH']);
	assert.deepEqual(missingOS.details.slice(1), ['Remote connection: SSH']);
});

test('About Ash command and dialog use the selected language', async () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		const { title, details } = await openAbout({ kind: 'remote', generation: 1, authority: 'private-authority' }, 'connected', OperatingSystem.Windows);
		assert.equal(title, '关于 Ash');
		assert.match(details[0]!, /^版本 \d+\.\d+\.\d+/);
		assert.deepEqual(details.slice(1), ['远程连接：其他', '远程操作系统：Windows']);
	} finally {
		resetNlsResolver();
	}
});
