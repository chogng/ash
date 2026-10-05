import assert from 'node:assert/strict';
import { test } from 'mocha';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { NATIVE_HOST_OPEN_WINDOW_CHANNEL, NATIVE_HOST_DIALOG_CHANNEL, NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL, NATIVE_HOST_SHELL_COMMAND_CHANNEL } from '../../../../platform/native/common/nativeHost.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import { nativeHostIpcRoutes } from '../../../../platform/native/electron-main/nativeHostIpc.js';
import { INativeHostService } from '../../../common/services.js';
import '../../../electron-browser/desktop.contribution.js';
import { CommandService } from '../../../services/commands/common/commandService.js';

test('desktop dialog and shell routes reject malformed requests', async () => {
	const operations: unknown[] = [];
	const routes = nativeHostIpcRoutes({
		isAdmin: async () => false,
		performDialogOperation: operation => { operations.push(operation); },
		performShellCommand: async operation => operation,
		pickFolder: async () => undefined, pickFile: async () => undefined, openWorkspace: async () => {},
		openWindow: async options => { operations.push(options); },
		openAgentsWindow: async options => { operations.push(options ?? 'openAgentsWindow'); },
		revealFile: () => {},
		saveFile: async () => undefined,
		isAccessibilitySupportEnabled: () => false,
		setWindowTheme: () => {}, setWindowDimmed: () => {}, toggleDeveloperTools: () => {},
		syncSystemWideKeybindings: () => ({ failed: [] }),
	});
	const dialog = routes.find(route => route.channel === NATIVE_HOST_DIALOG_CHANNEL);
	const shell = routes.find(route => route.channel === NATIVE_HOST_SHELL_COMMAND_CHANNEL);
	assert.ok(dialog);
	assert.ok(shell);
	assert.throws(() => dialog.validate({ kind: 'show', id: 0, request: { kind: 'message', severity: 'info', message: 'Hello' } }), /Invalid dialog ID/);
	assert.throws(() => dialog.validate({ kind: 'show', id: 1, request: { kind: 'message', severity: 'info', message: 'Hello', execute: 'bad' } }), /Invalid dialog request/);
	assert.deepEqual(dialog.validate({ kind: 'show', id: 2, request: { kind: 'choice', severity: 'warning', message: 'Choose', buttons: ['First', 'Second'], cancelButton: 'Cancel' } }),
		{ kind: 'show', id: 2, request: { kind: 'choice', severity: 'warning', message: 'Choose', buttons: ['First', 'Second'], cancelButton: 'Cancel' } });
	assert.throws(() => dialog.validate({ kind: 'show', id: 3, request: { kind: 'choice', message: 'Choose', buttons: [0] } }), /Invalid dialog request/);
	assert.throws(() => dialog.validate({ kind: 'show', id: 4, request: { kind: 'choice', severity: 'critical', message: 'Choose', buttons: ['First'], cancelButton: 'Cancel' } }), /Invalid dialog request/);
	await dialog.invoke(dialog.validate({ kind: 'show', id: 1, request: { kind: 'message', severity: 'info', message: 'Hello' } }));
	assert.equal(operations.length, 1);
	assert.throws(() => shell.validate('erase'), /Invalid shell command operation/);
	assert.equal(await shell.invoke(shell.validate('install')), 'install');
	const openAgents = routes.find(route => route.channel === NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL);
	assert.ok(openAgents);
	assert.throws(() => openAgents.validate({ windowId: 1 }), /Invalid Agents Window options/);
	assert.throws(() => openAgents.validate({}), /requires a conversation or draft/);
	assert.throws(() => openAgents.validate({ conversation: { sessionId: '', threadId: 'thread' } }), /Invalid Agents Window conversation/);
	assert.throws(() => openAgents.validate({ draft: { mode: 'debug', text: 'Review this', contexts: [{ id: 'file' }] } }), /Invalid Agents Window context/);
	const handoff = { conversation: { sessionId: 'session', threadId: 'thread' }, draft: { mode: 'debug', text: 'Review this', contexts: [{ id: 'file', kind: 'file', name: 'file.ts', content: 'const value = 1;' }] } };
	await openAgents.invoke(openAgents.validate(handoff));
	assert.deepEqual(operations.at(-1), handoff);
	await openAgents.invoke(openAgents.validate(undefined));
	assert.equal(operations.at(-1), 'openAgentsWindow');
	const openWindow = routes.find(route => route.channel === NATIVE_HOST_OPEN_WINDOW_CHANNEL);
	assert.ok(openWindow);
	assert.throws(() => openWindow.validate('/project'), /Invalid empty window options/);
	assert.throws(() => openWindow.validate({ remoteAuthority: 'ssh+user@host' }), /Remote SSH host/);
	await openWindow.invoke(openWindow.validate({ forceReuseWindow: true, remoteAuthority: 'ssh+work-server' }));
	assert.deepEqual(operations.at(-1), { forceReuseWindow: true, remoteAuthority: 'ssh+work-server' });
});

test('desktop window commands reach the window host', async () => {
	using services = new InstantiationService();
	using configuration = new InMemoryConfigurationService();
	services.registerInstance(IConfigurationService, configuration);
	const calls: string[] = [];
	let zoom = 0;
	let alwaysOnTop = false;
	services.registerInstance(INativeHostService, {
		isAdmin: async () => false,
		onDidRequestOpenExternalUri: () => ({ dispose() {} }),
		openExternal: async () => { throw new Error('unused'); },
		showNativeDialog: async () => { throw new Error('unused'); },
		installShellCommand: async () => '',
		uninstallShellCommand: async () => '',
		listWindows: async () => [],
		focusWindowById: async id => { calls.push(`focus:${id}`); },
		focusWindow: async () => { calls.push('focusSelf'); },
		closeWindow: async () => { calls.push('close'); },
		closeOtherWindows: async () => { calls.push('closeOthers'); },
		getZoomLevel: async () => zoom,
		onDidChangeZoomLevel: () => ({ dispose() {} }),
		setZoomLevel: async level => { zoom = level; calls.push(`zoom:${level}`); },
		isAlwaysOnTop: async () => alwaysOnTop,
		setAlwaysOnTop: async enabled => { alwaysOnTop = enabled; calls.push(`top:${enabled}`); },
		performNativeTabAction: async action => { calls.push(`tab:${action}`); },
		openNewWindowTab: async () => { calls.push('newTab'); },
		pickFolder: async () => undefined,
		pickFile: async () => undefined,
		openWorkspace: async () => {},
		openWindow: async () => {},
		openAgentsWindow: async () => { calls.push('openAgentsWindow'); },
		syncSystemWideKeybindings: async () => ({ failed: [] }),
		revealFile: async () => {},
		setWindowTheme: async () => {},
		setWindowDimmed: async () => {},
		toggleDeveloperTools: async () => {},
		saveFile: async () => undefined,
		getOSColorScheme: async () => ({ dark: false, highContrast: false }),
		onDidChangeColorScheme: () => ({ dispose() {} }),
		isAccessibilitySupportEnabled: async () => false,
		onDidChangeAccessibilitySupport: () => ({ dispose() {} }),
	});
	using commands = new CommandService(services);
	await commands.executeCommand('workbench.action.zoomIn');
	await commands.executeCommand('workbench.action.zoomOut');
	await commands.executeCommand('workbench.action.zoomReset');
	await commands.executeCommand('workbench.action.toggleWindowAlwaysOnTop');
	await commands.executeCommand('workbench.action.focusWindow');
	await commands.executeCommand('workbench.action.newWindowTab');
	await commands.executeCommand('workbench.action.showNextWindowTab');
	await commands.executeCommand('workbench.action.closeOtherWindows');
	await commands.executeCommand('workbench.action.closeWindow');
	assert.deepEqual(calls, ['zoom:1', 'zoom:0', 'zoom:0', 'top:true', 'focusSelf', 'newTab', 'tab:next', 'closeOthers', 'close']);
});

test('quick window switching focuses the next registered window', async () => {
	using services = new InstantiationService();
	services.registerInstance(INativeHostService, {
		isAdmin: async () => false,
		listWindows: async () => [{ id: 1, title: 'Workbench', focused: true }, { id: 2, title: 'Agents', focused: false }],
		focusWindowById: async (id: number) => { assert.equal(id, 2); },
	} as unknown as INativeHostApi);
	using commands = new CommandService(services);
	await commands.executeCommand('workbench.action.quickSwitchWindow');
});
