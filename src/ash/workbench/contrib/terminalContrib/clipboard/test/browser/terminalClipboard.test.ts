import assert from 'node:assert/strict';
import { test } from 'mocha';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IDialogService, DialogResult } from '../../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { TerminalSettingId } from '../../../../../../platform/terminal/common/terminal.js';
import { DialogService } from '../../../../../services/dialogs/common/dialogService.js';
import '../../../../terminal/common/terminalConfiguration.js';
import { shouldPasteTerminalText } from '../../browser/terminalClipboard.js';

for (const newline of ['\n', '\r\n', '\r']) {
	test(`terminal paste handles ${JSON.stringify(newline)} with auto, always and never policies`, async () => {
		using services = new InstantiationService();
		using configuration = new InMemoryConfigurationService();
		using dialogs = new DialogService();
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IDialogService, dialogs);
		let confirmations = 0;
		using listener = dialogs.model.onWillShowDialog(item => {
			confirmations++;
			item.close({ button: DialogResult.Cancel });
		});
		const paste = (text: string, bracketed = false) => services.invokeFunction(shouldPasteTerminalText, text, bracketed);
		const single = `echo hello${newline} \t`;
		const multiple = `echo hello${newline}echo world`;
		assert.equal(configuration.getValue(TerminalSettingId.EnableMultiLinePasteWarning), 'auto');
		assert.equal(await paste('echo hello'), true);
		assert.deepEqual(await paste(single), { modifiedText: 'echo hello' });
		assert.equal(await paste(single, true), true);
		assert.equal(await paste(multiple), false);
		assert.equal(await paste(multiple, true), true);
		assert.equal(confirmations, 1);

		await configuration.updateValue(TerminalSettingId.EnableMultiLinePasteWarning, 'always');
		assert.equal(await paste('echo hello'), true);
		assert.equal(await paste(single), false);
		assert.equal(await paste(multiple, true), false);
		assert.equal(confirmations, 3);
		await configuration.updateValue(TerminalSettingId.EnableMultiLinePasteWarning, 'never');
		assert.equal(await paste(single), true);
		assert.equal(await paste(multiple, true), true);
		assert.equal(confirmations, 3);
	});
}

test('terminal paste confirmation bounds its preview without rewriting accepted text', async () => {
	using services = new InstantiationService();
	using configuration = new InMemoryConfigurationService();
	using dialogs = new DialogService();
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IDialogService, dialogs);
	using listener = dialogs.model.onWillShowDialog(item => {
		assert.ok(item.request.detail!.length < 2200);
		assert.ok(item.request.detail!.split('\n').length <= 12);
		assert.ok(!item.request.detail!.includes('hidden tail'));
		item.close({ button: DialogResult.Primary });
	});
	const text = `${'a'.repeat(3000)}\n${'line\n'.repeat(20)}hidden tail`;
	assert.equal(await services.invokeFunction(shouldPasteTerminalText, text, false), true);
});
