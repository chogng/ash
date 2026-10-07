import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../base/common/event.js';
import { DialogSeverity, IDialogService, type IMessageDialogOptions } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import { INativeHostService } from '../../../common/services.js';
import { InstallShellCommandAction, UninstallShellCommandAction } from '../installActions.js';

test('shell command actions report the installed path and installation errors', async () => {
	using services = new InstantiationService();
	const messages: IMessageDialogOptions[] = [];
	services.registerInstance(IDialogService, {
		onWillShowDialog: Event.None,
		onDidShowDialog: Event.None,
		about: async () => { throw new Error('Unexpected about dialog'); },
		showMessage: async options => { messages.push(options); },
		info: async () => { },
		warn: async () => { },
		error: async () => { },
		confirm: async () => ({ confirmed: false }),
		prompt: async () => { throw new Error('unused'); },
		input: async () => { throw new Error('unused'); },
	});
	services.registerInstance(INativeHostService, {
		installShellCommand: async () => '/usr/local/bin/ash',
		uninstallShellCommand: async () => { throw new Error('Permission denied'); },
	} as unknown as INativeHostApi);
	await new InstallShellCommandAction().run(services);
	await new UninstallShellCommandAction().run(services);
	assert.deepEqual(messages.map(message => message.severity), [DialogSeverity.Info, DialogSeverity.Error]);
	assert.match(messages[0]!.message, /\/usr\/local\/bin\/ash/);
	assert.equal(messages[1]!.message, 'Permission denied');
});
