import assert from 'node:assert/strict';
import { test } from 'mocha';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { DialogResult, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { DialogService } from '../../../../services/dialogs/common/dialogService.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { ShowAboutDialogAction } from '../../windowActions.js';

test('About Ash command opens the version dialog', async () => {
	using registration = registerAction2(ShowAboutDialogAction);
	using services = new ServiceContainer();
	using dialogs = new DialogService();
	services.registerInstance(IDialogService, dialogs);
	using commands = new CommandService(services);
	const command = commands.executeCommand('workbench.action.showAboutDialog');
	const item = dialogs.model.dialogs[0];
	assert.ok(item);
	assert.equal(item?.request.kind, 'message');
	assert.equal(item?.request.title, 'About Ash');
	assert.match(item?.request.detail ?? '', /^Version \d+\.\d+\.\d+/);
	item.close({ button: DialogResult.Primary });
	await command;
});

test('About Ash command and dialog use the selected language', async () => {
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using registration = registerAction2(ShowAboutDialogAction);
		using services = new ServiceContainer();
		using dialogs = new DialogService();
		services.registerInstance(IDialogService, dialogs);
		using commands = new CommandService(services);
		const command = commands.executeCommand('workbench.action.showAboutDialog');
		const item = dialogs.model.dialogs[0];
		assert.ok(item);
		assert.equal(item.request.title, '关于 Ash');
		assert.match(item.request.detail ?? '', /^版本 \d+\.\d+\.\d+/);
		item.close({ button: DialogResult.Primary });
		await command;
	} finally {
		resetNlsResolver();
	}
});
