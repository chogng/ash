import assert from 'node:assert/strict';
import { test } from 'mocha';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IGitService } from '../../common/gitService.js';
import { IWorkspaceOpenService } from '../../../../services/workspaces/browser/workspaceOpenService.js';
import { GitCloneCommandId } from '../../common/gitCommands.js';
import '../../browser/gitClone.js';

test('Git clone command asks for a repository, clones it, and opens the result', async () => {
	const calls: string[] = [];
	using services = new ServiceContainer();
	services.registerInstance(IGitService, {
		canCloneRepository: true,
		cloneRepository: async (url: string, parent: string) => {
			calls.push(`clone:${url}:${parent}`);
			return '/projects/example';
		},
	} as IGitService);
	services.registerInstance(IWorkspaceOpenService, {
		pickFolder: async () => { calls.push('pickFolder'); return '/projects'; },
		openWorkspace: async (path: string) => { calls.push(`open:${path}`); },
	} as IWorkspaceOpenService);
	services.registerInstance(IQuickInputService, {
		input: async (options: { title?: string }) => { calls.push(options.title ?? ''); return ' https://example.com/example.git '; },
	} as IQuickInputService);
	services.registerInstance(INotificationService, {
		info: () => ({ close: () => calls.push('closeProgress') }),
	} as unknown as INotificationService);
	services.registerInstance(IDialogService, {
		confirm: async (options: { primaryButton?: string }) => { calls.push(options.primaryButton ?? ''); return { confirmed: true }; },
	} as unknown as IDialogService);
	using commands = new CommandService(services);
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		await commands.executeCommand(GitCloneCommandId);
	} finally {
		resetNlsResolver();
	}
	assert.deepEqual(calls, [
		'克隆仓库',
		'pickFolder',
		'clone:https://example.com/example.git:/projects',
		'closeProgress',
		'打开仓库',
		'open:/projects/example',
	]);
});
