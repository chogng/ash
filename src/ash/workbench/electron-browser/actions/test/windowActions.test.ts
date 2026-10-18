import assert from 'node:assert/strict';
import { test, suiteSetup, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { registerExternalFocusChecker } from '../../../../base/browser/dom.js';
import type { BrowserWindow } from '../../../../base/browser/window.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { NATIVE_HOST_OPEN_WINDOW_CHANNEL, NATIVE_HOST_DIALOG_CHANNEL, NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL } from '../../../../platform/native/common/nativeHost.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import { nativeHostIpcRoutes } from '../../../../platform/native/electron-main/nativeHostIpc.js';
import { INativeHostService } from '../../../common/services.js';
import '../../../electron-browser/desktop.contribution.js';
import { CommandService } from '../../../services/commands/common/commandService.js';

const environment = new JSDOM('<!doctype html><body></body>');
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
suiteSetup(() => Object.defineProperty(globalThis, 'window', { configurable: true, value: environment.window }));
suiteTeardown(() => {
	environment.window.close();
	if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
	else Reflect.deleteProperty(globalThis, 'window');
});

test('desktop dialog and window routes reject malformed requests', async () => {
	const operations: unknown[] = [];
	const routes = nativeHostIpcRoutes({
		moveTerminalToWindow: async () => { throw new Error('Unexpected terminal transfer'); },
		takeTerminalTransfer: () => undefined,
		completeTerminalTransfer: () => { throw new Error('Unexpected terminal transfer completion'); },
		getAgentHostEditorState: () => { throw new Error('Unused invitation capability'); },
		updateAgentHostEditorState: () => { throw new Error('Unused invitation capability'); },
		claimAgentsWindowInvitation: () => { throw new Error('Unused invitation capability'); },
		markAgentsWindowInvitationShown: () => { throw new Error('Unused invitation capability'); },
		releaseAgentsWindowInvitation: () => { throw new Error('Unused invitation capability'); },
		getTitleBarStyle: () => 'custom',
		isAdmin: async () => false,
		performDialogOperation: operation => { operations.push(operation); },
		pickFolder: async () => undefined, showOpenDialog: async () => ({ canceled: true, filePaths: [] }), openWorkspace: async () => { },
		openWindow: async options => { operations.push(options); },
		openAgentsWindow: async options => { operations.push(options ?? 'openAgentsWindow'); },
		revealFile: () => { },
		showSaveDialog: async () => ({ canceled: true, filePath: '' }),
		isAccessibilitySupportEnabled: () => false,
		setWindowTheme: () => { }, setWindowDimmed: () => { }, toggleDeveloperTools: () => { },
		syncSystemWideKeybindings: () => ({ failed: [] }),
	});
	const dialog = routes.find(route => route.channel === NATIVE_HOST_DIALOG_CHANNEL);
	assert.ok(dialog);
	assert.throws(() => dialog.validate({ kind: 'show', id: 0, options: { type: 'info', message: 'Hello' } }), /Invalid dialog ID/);
	assert.throws(() => dialog.validate({ kind: 'show', id: 1, options: { type: 'info', message: 'Hello', execute: 'bad' } }), /Invalid message box options/);
	assert.deepEqual(dialog.validate({ kind: 'show', id: 2, options: { type: 'warning', message: 'Choose', buttons: ['First', 'Second', 'Cancel'], cancelId: 2 } }),
		{ kind: 'show', id: 2, options: { type: 'warning', message: 'Choose', buttons: ['First', 'Second', 'Cancel'], cancelId: 2 } });
	assert.throws(() => dialog.validate({ kind: 'show', id: 3, options: { message: 'Choose', buttons: [0] } }), /Invalid message box buttons/);
	assert.throws(() => dialog.validate({ kind: 'show', id: 4, options: { type: 'critical', message: 'Choose', buttons: ['First', 'Cancel'] } }), /Invalid message box options/);
	await dialog.invoke(dialog.validate({ kind: 'show', id: 1, options: { type: 'info', message: 'Hello' } }));
	assert.equal(operations.length, 1);
	const openAgents = routes.find(route => route.channel === NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL);
	assert.ok(openAgents);
	assert.throws(() => openAgents.validate({ windowId: 1 }), /Invalid Agents Window options/);
	assert.throws(() => openAgents.validate({}), /requires a conversation or draft/);
	assert.throws(() => openAgents.validate({ conversation: { sessionId: '', threadId: 'thread' } }), /Invalid Agents Window conversation/);
	assert.throws(() => openAgents.validate({ draft: { mode: 'debug', text: 'Review this', contexts: [{ id: 'file' }] } }), /Invalid Agents Window context/);
	const handoff = { conversation: { sessionId: 'session', threadId: 'thread' }, draft: { mode: 'debug', text: 'Review this', contexts: [{ id: 'file', kind: 'file', name: 'file.ts', content: 'const value = 1;' }] } };
	await openAgents.invoke(openAgents.validate(handoff));
	assert.deepEqual(operations.at(-1), handoff);
	const terminalDraft = { draft: { mode: 'agent', text: '', contexts: [{ id: 'terminal', kind: 'terminal', name: 'Shell', content: 'saved', terminalSnapshot: { text: 'saved', columns: 80 } }] } };
	assert.deepEqual(openAgents.validate(terminalDraft), terminalDraft);
	for (const snapshot of [{ text: 'saved', columns: 0 }, { text: 'saved', columns: Infinity }, { text: 'x'.repeat(131073), columns: 80 }, { text: 'saved', columns: 80, execute: true }]) {
		assert.throws(() => openAgents.validate({ draft: { ...terminalDraft.draft, contexts: [{ ...terminalDraft.draft.contexts[0], terminalSnapshot: snapshot }] } }), /Invalid terminal snapshot/);
	}
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
	services.registerInstance(ILayoutService, { activeContainer: environment.window.document.body } as ILayoutService);
	using configuration = new InMemoryConfigurationService();
	services.registerInstance(IConfigurationService, configuration);
	const calls: string[] = [];
	let zoom = 0;
	let alwaysOnTop = false;
	services.registerInstance(INativeHostService, {
		onDidSuspendOS: () => ({ dispose() { } }),
		onDidResumeOS: () => ({ dispose() { } }),
		getScreenshot: async () => { throw new Error('Unused screenshot capability'); },
		moveTerminalToWindow: async () => { throw new Error('Unexpected terminal transfer'); },
		takeTerminalTransfer: async () => undefined,
		completeTerminalTransfer: async () => { throw new Error('Unexpected terminal transfer completion'); },
		onDidRequestTerminalTransfer: () => ({ dispose() { } }),
		getAgentHostEditorState: () => { throw new Error('Unused invitation capability'); },
		updateAgentHostEditorState: () => { throw new Error('Unused invitation capability'); },
		claimAgentsWindowInvitation: () => { throw new Error('Unused invitation capability'); },
		markAgentsWindowInvitationShown: () => { throw new Error('Unused invitation capability'); },
		releaseAgentsWindowInvitation: () => { throw new Error('Unused invitation capability'); },
		onDidChangeAgentHostEditorState: () => { throw new Error('Unused invitation capability'); },
		getTitleBarStyle: async () => 'custom',
		isAdmin: async () => false,
		onDidRequestOpenExternalUri: () => ({ dispose() { } }),
		openExternal: async () => { throw new Error('unused'); },
		showMessageBox: async () => { throw new Error('unused'); },
		listWindows: async () => [],
		focusWindowById: async id => { calls.push(`focus:${id}`); },
		focusWindow: async () => { calls.push('focusSelf'); },
		closeWindow: async () => { calls.push('close'); },
		closeOtherWindows: async () => { calls.push('closeOthers'); },
		getZoomLevel: async () => zoom,
		onDidChangeZoomLevel: () => ({ dispose() { } }),
		setZoomLevel: async level => { zoom = level; calls.push(`zoom:${level}`); },
		getAuxiliaryWindowState: async () => { throw new Error('Unused window state'); },
		onDidChangeAuxiliaryWindowState: () => ({ dispose() { } }),
		onDidChangeWindowAlwaysOnTop: () => ({ dispose() { } }),
		isAlwaysOnTop: async () => alwaysOnTop,
		setAlwaysOnTop: async enabled => { alwaysOnTop = enabled; calls.push(`top:${enabled}`); },
		performNativeTabAction: async action => { calls.push(`tab:${action}`); },
		openNewWindowTab: async () => { calls.push('newTab'); },
		pickFolder: async () => undefined,
		showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
		openWorkspace: async () => { },
		openWindow: async () => { },
		openAgentsWindow: async () => { calls.push('openAgentsWindow'); },
		syncSystemWideKeybindings: async () => ({ failed: [] }),
		revealFile: async () => { },
		setWindowTheme: async () => { },
		setWindowDimmed: async () => { },
		toggleDeveloperTools: async () => { },
		showSaveDialog: async () => ({ canceled: true, filePath: '' }),
		getOSColorScheme: async () => ({ dark: false, highContrast: false }),
		onDidChangeColorScheme: () => ({ dispose() { } }),
		isAccessibilitySupportEnabled: async () => false,
		onDidChangeAccessibilitySupport: () => ({ dispose() { } }),
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

test('quick window switching advances from the caller even when another window owns OS focus', async () => {
	using services = new InstantiationService();
	services.registerInstance(ILayoutService, { activeContainer: environment.window.document.body } as ILayoutService);
	services.registerInstance(INativeHostService, {
		isAdmin: async () => false,
		listWindows: async () => [{ id: 1, title: 'Workbench', focused: true, current: false }, { id: 2, title: 'Agents', focused: false, current: true }],
		focusWindowById: async (id: number) => { assert.equal(id, 1); },
	} as unknown as INativeHostApi);
	using commands = new CommandService(services);
	await commands.executeCommand('workbench.action.quickSwitchWindow');
});

test('quick window switching captures the auxiliary input container for the caller identity', async () => {
	using services = new InstantiationService();
	const popup = new JSDOM('<!doctype html><body></body>');
	popup.window.name = 'ash-auxiliary-12345678-1234-1234-1234-123456789abc';
	services.registerInstance(ILayoutService, { activeContainer: popup.window.document.body } as ILayoutService);
	const calls: unknown[] = [];
	services.registerInstance(INativeHostService, {
		listWindows: async (name?: string) => {
			calls.push(name);
			return [{ id: 1, title: 'Workbench', focused: true, current: false }, { id: 2, title: 'Editor', focused: false, current: true }];
		},
		focusWindowById: async (id: number) => { calls.push(id); },
	} as unknown as INativeHostApi);
	using commands = new CommandService(services);
	try {
		await commands.executeCommand('workbench.action.quickSwitchWindow');
		assert.deepEqual(calls, [popup.window.name, 1]);
	} finally { popup.window.close(); }
});

test('always-on-top commands capture the focused editor window before awaiting the host', async () => {
	using services = new InstantiationService();
	const popup = new JSDOM('<!doctype html><body></body>');
	popup.window.name = 'ash-auxiliary-12345678-1234-1234-1234-123456789abc';
	let focused = true;
	using focus = registerExternalFocusChecker(() => ({ hasFocus: focused, window: popup.window as unknown as BrowserWindow }));
	const calls: unknown[] = [];
	services.registerInstance(INativeHostService, {
		isAlwaysOnTop: async (name: string | undefined) => { calls.push(['read', name]); focused = false; return false; },
		setAlwaysOnTop: async (enabled: boolean, name: string | undefined) => { calls.push([enabled, name]); },
	} as INativeHostApi);
	using commands = new CommandService(services);
	try {
		await commands.executeCommand('workbench.action.toggleWindowAlwaysOnTop');
		focused = true;
		await commands.executeCommand('workbench.action.enableWindowAlwaysOnTop');
		await commands.executeCommand('workbench.action.disableWindowAlwaysOnTop');
		assert.deepEqual(calls, [['read', popup.window.name], [true, popup.window.name], [true, popup.window.name], [false, popup.window.name]]);
	} finally { popup.window.close(); }
});

test('always-on-top commands use the active workbench container when documents both report focus', async () => {
	using services = new InstantiationService();
	const popup = new JSDOM('<!doctype html><body></body>');
	popup.window.name = 'ash-auxiliary-12345678-1234-1234-1234-123456789abc';
	const calls: unknown[] = [];
	services.registerInstance(ILayoutService, { activeContainer: popup.window.document.body } as ILayoutService);
	services.registerInstance(INativeHostService, {
		isAlwaysOnTop: async () => false,
		setAlwaysOnTop: async (enabled: boolean, name: string | undefined) => { calls.push([enabled, name]); },
	} as INativeHostApi);
	using commands = new CommandService(services);
	const focused = Object.getOwnPropertyDescriptor(environment.window.document, 'hasFocus');
	Object.defineProperty(environment.window.document, 'hasFocus', { configurable: true, value: () => true });
	try {
		await commands.executeCommand('workbench.action.toggleWindowAlwaysOnTop');
		await commands.executeCommand('workbench.action.enableWindowAlwaysOnTop');
		await commands.executeCommand('workbench.action.disableWindowAlwaysOnTop');
		assert.deepEqual(calls, [[true, popup.window.name], [true, popup.window.name], [false, popup.window.name]]);
	} finally {
		if (focused) Object.defineProperty(environment.window.document, 'hasFocus', focused);
		else Reflect.deleteProperty(environment.window.document, 'hasFocus');
		popup.window.close();
	}
});


test('window close, focus and zoom commands use the auxiliary input container', async () => {
	using services = new InstantiationService();
	using configuration = new InMemoryConfigurationService();
	services.registerInstance(IConfigurationService, configuration);
	const popup = new JSDOM('<!doctype html><body></body>');
	popup.window.name = 'ash-auxiliary-12345678-1234-1234-1234-123456789abc';
	services.registerInstance(ILayoutService, { activeContainer: popup.window.document.body } as ILayoutService);
	const calls: unknown[] = [];
	services.registerInstance(INativeHostService, {
		closeWindow: async (name?: string) => { calls.push(['close', name]); },
		focusWindow: async (name?: string) => { calls.push(['focus', name]); },
		getZoomLevel: async (name?: string) => { calls.push(['read', name]); return 1; },
		setZoomLevel: async (level: number, name?: string, all?: boolean) => { calls.push([level, name, all]); },
	} as INativeHostApi);
	using commands = new CommandService(services);
	try {
		await commands.executeCommand('workbench.action.focusWindow');
		await commands.executeCommand('workbench.action.zoomIn');
		await commands.executeCommand('workbench.action.zoomOut');
		await commands.executeCommand('workbench.action.zoomReset');
		await commands.executeCommand('workbench.action.closeWindow');
		assert.deepEqual(calls, [['focus', popup.window.name], ['read', popup.window.name], [2, popup.window.name, false], ['read', popup.window.name], [0, popup.window.name, false], [0, popup.window.name, false], ['close', popup.window.name]]);
		calls.length = 0;
		await configuration.updateValue('window.zoomPerWindow', false);
		await commands.executeCommand('workbench.action.zoomIn');
		assert.deepEqual(calls, [['read', popup.window.name], [2, undefined, true]]);
		assert.equal(configuration.getValue('window.zoomLevel'), 2);
	} finally { popup.window.close(); }
});
