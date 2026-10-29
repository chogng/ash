import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../../../services/configuration/test/common/testServices.js';
import { BrowserStorageService } from '../../../../../../workbench/services/storage/browser/storageService.js';
import '../../../../terminal/common/terminalConfiguration.js';
import { TerminalCommandHistory, TerminalDirectoryHistory } from '../../common/history.js';
import { TerminalHistorySettingId } from '../../common/terminal.history.js';

test('Terminal command history isolates PowerShell, Bash and Zsh and rejects untrusted or Task command text', () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({
			ownerWindow: dom.window as unknown as Window,
			workspaceId: 'terminal-history',
			backend: dom.window.localStorage,
			flushInterval: 0,
		});
		using configuration = new WorkbenchConfigurationService();
		const history = new TerminalCommandHistory(configuration, storage);
		for (const shellId of ['powershell', 'bash', 'zsh']) {
			history.record(shellId, 'succeeded', `echo ${shellId}`, true, false);
		}
		history.record('bash', 'succeeded', 'printf untrusted', false, false);
		history.record('bash', 'succeeded', 'printf missing nonce', undefined, false);
		history.record('bash', 'succeeded', 'printf task', true, true);
		history.record('bash', 'running', 'printf still-running', true, false);

		assert.deepEqual(
			history.getCommands('powershell').map(entry => entry.command),
			['echo powershell'],
		);
		assert.deepEqual(
			history.getCommands('bash').map(entry => entry.command),
			['echo bash'],
		);
		assert.deepEqual(
			history.getCommands('zsh').map(entry => entry.command),
			['echo zsh'],
		);
		assert.deepEqual(storage.keys(StorageScope.APPLICATION, StorageTarget.MACHINE), [
			'terminal.shellIntegration.commandHistory.v1',
		]);
	} finally {
		dom.window.close();
	}
});

test('directory history persists newest verified paths per host and ignores unsafe or disabled entries', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({
			ownerWindow: dom.window as unknown as Window,
			workspaceId: 'directories',
			backend: dom.window.localStorage,
			flushInterval: 0,
		});
		using configuration = new WorkbenchConfigurationService();
		await configuration.updateValue(TerminalHistorySettingId.ShellIntegrationCommandHistory, 2);
		const history = new TerminalDirectoryHistory(configuration, storage);
		for (const path of ['/old', '/a b', "/quote';$(no)", '/a b']) history.record('ssh:first', path, true, false);
		history.record('ssh:second', 'C:\\remote\\path', true, false);
		history.record('ssh:first', '/untrusted', false, false);
		history.record('ssh:first', '/private', true, true);
		for (const path of ['relative', '/line\nfeed', '/control\x1b']) history.record('ssh:first', path, true, false);
		assert.deepEqual(history.getDirectories('ssh:first'), ['/a b', "/quote';$(no)"]);
		assert.deepEqual(history.getDirectories('ssh:second'), ['C:\\remote\\path']);
		const restored = new TerminalDirectoryHistory(configuration, storage);
		assert.deepEqual(restored.getDirectories('ssh:first'), history.getDirectories('ssh:first'));
		await configuration.updateValue(TerminalHistorySettingId.ShellIntegrationCommandHistory, 0);
		assert.deepEqual(restored.getDirectories('ssh:first'), []);
		restored.record('ssh:first', '/not saved', true, false);
		await configuration.updateValue(TerminalHistorySettingId.ShellIntegrationCommandHistory, 2);
		assert.deepEqual(restored.getDirectories('ssh:first'), ['/a b', "/quote';$(no)"]);
		restored.clear();
		assert.deepEqual(history.getDirectories('ssh:first'), []);
	} finally {
		dom.window.close();
	}
});

test('Terminal command history survives a new StorageService and keeps newest profile commands first', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		const options = {
			ownerWindow: dom.window as unknown as Window,
			backend: dom.window.localStorage,
			flushInterval: 0,
		};
		using firstStorage = new BrowserStorageService({ ...options, workspaceId: 'workspace-one' });
		using firstConfiguration = new WorkbenchConfigurationService();
		await firstConfiguration.updateValue(TerminalHistorySettingId.ShellIntegrationCommandHistory, 2);
		const firstHistory = new TerminalCommandHistory(firstConfiguration, firstStorage);
		firstHistory.record('powershell', 'succeeded', 'Write-Output one', true, false);
		firstHistory.record('powershell', 'failed', 'Write-Output two', true, false);
		firstHistory.record('powershell', 'succeeded', 'Write-Output three', true, false);
		firstHistory.record('bash', 'succeeded', 'echo bash', true, false);
		await firstStorage.flush();

		using restoredStorage = new BrowserStorageService({ ...options, workspaceId: 'workspace-two' });
		using restoredConfiguration = new WorkbenchConfigurationService();
		await restoredConfiguration.updateValue(TerminalHistorySettingId.ShellIntegrationCommandHistory, 2);
		const restoredHistory = new TerminalCommandHistory(restoredConfiguration, restoredStorage);
		assert.deepEqual(
			restoredHistory.getCommands('powershell').map(entry => entry.command),
			['Write-Output three', 'Write-Output two'],
		);
		assert.deepEqual(
			restoredHistory.getCommands('bash').map(entry => entry.command),
			['echo bash'],
		);
		await restoredConfiguration.updateValue(TerminalHistorySettingId.ShellIntegrationCommandHistory, 1);
		assert.deepEqual(
			restoredHistory.getCommands('powershell').map(entry => entry.command),
			['Write-Output three'],
		);
	} finally {
		dom.window.close();
	}
});

test('Terminal command history disables writes at limit zero and ignores malformed stored entries', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({
			ownerWindow: dom.window as unknown as Window,
			workspaceId: 'terminal-history-invalid',
			backend: dom.window.localStorage,
			flushInterval: 0,
		});
		using configuration = new WorkbenchConfigurationService();
		const history = new TerminalCommandHistory(configuration, storage);
		storage.store(
			'terminal.shellIntegration.commandHistory.v1',
			'{',
			StorageScope.APPLICATION,
			StorageTarget.MACHINE,
		);
		assert.deepEqual(history.getCommands('powershell'), []);
		await configuration.updateValue(TerminalHistorySettingId.ShellIntegrationCommandHistory, 0);
		history.record('powershell', 'succeeded', 'Write-Output hidden', true, false);
		assert.deepEqual(history.getCommands('powershell'), []);
		assert.equal(storage.get('terminal.shellIntegration.commandHistory.v1', StorageScope.APPLICATION), '{');
	} finally {
		dom.window.close();
	}
});
