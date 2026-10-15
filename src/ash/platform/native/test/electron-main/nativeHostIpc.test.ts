import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../base/common/event.js';
import { colorSchemeChannel } from '../../electron-main/nativeHostIpc.js';
import type { IColorScheme } from '../../../window/common/window.js';
import { WINDOW_ALWAYS_ON_TOP_CHANGED_CHANNEL, type IWindowAlwaysOnTopChangedEvent } from '../../../window/common/window.js';
import { isAdmin, performShellCommand } from '../../electron-main/nativeHostMainService.js';
import { nativeHostIpcRoutes, type INativeHostMainService } from '../../electron-main/nativeHostIpc.js';
import { NATIVE_HOST_IS_ADMIN_CHANNEL, NATIVE_HOST_SHELL_COMMAND_CHANNEL, NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL, NATIVE_HOST_OPEN_WORKSPACE_CHANNEL } from '../../common/nativeHost.js';
import type { BrowserWindow } from 'electron';
import type { MessageBoxReturnValue } from '../../../../base/parts/sandbox/common/electronTypes.js';
import type { ISandboxGlobals } from '../../../../base/parts/sandbox/electron-browser/sandboxTypes.js';
import type { IMainProcessService } from '../../../ipc/common/mainProcessService.js';
import { DialogMainService } from '../../../dialogs/electron-main/dialogMainService.js';
import { validateNativeDialogOperation, validateOpenDialogResult, validateSaveDialogResult, validateMessageBoxResult } from '../../common/nativeHost.js';

test('shell command IPC reaches the system host and rejects an unsupported installation before writing files', async () => {
	const route = nativeHostIpcRoutes({
		performShellCommand: operation => performShellCommand(operation, { isPackaged: false, executablePath: process.execPath }),
	} as INativeHostMainService).find(route => route.channel === NATIVE_HOST_SHELL_COMMAND_CHANNEL)!;
	assert.throws(() => route.validate('erase'), /Invalid shell command operation/);
	for (const operation of ['install', 'uninstall']) {
		await assert.rejects(async () => route.invoke(route.validate(operation)), process.platform === 'darwin'
			? /requires a packaged Ash application/
			: /requires macOS/);
	}
});

test('window frame reads use the creation value and reject renderer arguments', async () => {
	const route = nativeHostIpcRoutes({ getTitleBarStyle: () => 'custom' } as INativeHostMainService).find(route => route.channel === 'ash:native-host:get-title-bar-style')!;
	assert.throws(() => route.validate({ titleBarStyle: 'system' }), /no arguments/);
	assert.equal(await route.invoke(route.validate(undefined)), 'custom');
});

test('desktop privilege reads use the desktop process and accept no renderer arguments', async () => {
	if (process.platform !== 'win32') {
		assert.equal(await isAdmin(), process.geteuid!() === 0);
	}
	let calls = 0;
	const route = nativeHostIpcRoutes({ isAdmin: async () => { calls++; return true; } } as INativeHostMainService).find(route => route.channel === NATIVE_HOST_IS_ADMIN_CHANNEL)!;
	assert.throws(() => route.validate({ pid: 123 }), /no arguments/);
	assert.equal(await route.invoke(route.validate(undefined)), true);
	assert.equal(calls, 1);
});

test('the Main color channel exposes only its named read and change event without arguments', async () => {
	using changes = new Emitter<IColorScheme>();
	const scheme = { dark: false, highContrast: true };
	const channel = colorSchemeChannel({
		onDidChangeColorScheme: changes.event,
		getColorScheme: () => scheme,
		getBackgroundColor: () => { throw new Error('Unexpected background read'); },
		getWindowSplash: () => { throw new Error('Unexpected splash read'); },
		saveWindowSplash: async () => { throw new Error('Unexpected splash write'); },
	});
	assert.deepEqual(await channel.call('window:1', 'getOSColorScheme'), scheme);
	await assert.rejects(channel.call('window:1', 'saveWindowTheme'), /Invalid system color scheme read/);
	await assert.rejects(channel.call('window:1', 'getOSColorScheme', { windowId: 2 }), /Invalid system color scheme read/);
	assert.throws(() => channel.listen('window:1', 'unknown'), /Invalid system color scheme subscription/);
	assert.throws(() => channel.listen('window:1', 'onDidChangeColorScheme', true), /Invalid system color scheme subscription/);
	const received: IColorScheme[] = [];
	using subscription = channel.listen<IColorScheme>('window:1', 'onDidChangeColorScheme')(value => received.push(value));
	changes.fire(scheme);
	subscription.dispose();
	changes.fire({ dark: true, highContrast: false });
	assert.deepEqual(received, [scheme]);
});


test('Agents Window handoff preserves optional context sources and rejects malformed attachments', async () => {
	let opened: unknown;
	const route = nativeHostIpcRoutes({ openAgentsWindow: async options => { opened = options; } } as INativeHostMainService).find(route => route.channel === NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL)!;
	const context = { id: 'file', kind: 'file', name: 'brief.ts', content: 'Snapshot', resource: 'file:///workspace/brief.ts' };
	const options = { draft: { mode: 'agent', text: '', contexts: [context, { id: 'text', kind: 'file', name: 'upload.txt', content: 'Upload' }] } };
	await route.invoke(route.validate(options));
	assert.deepEqual(opened, options);
	for (const attachment of [{ ...context, resource: 42 }, { ...context, unexpected: true }, { resource: context.resource }]) {
		assert.throws(() => route.validate({ draft: { ...options.draft, contexts: [attachment] } }), /Invalid Agents Window context/);
	}
});

test('Agents Window handoff validates inline code reference positions against the message', async () => {
	const route = nativeHostIpcRoutes({ openAgentsWindow: async () => { } } as INativeHostMainService).find(route => route.channel === NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL)!;
	const context = { id: 'selection', kind: 'codeSelection', name: 'file.ts (6-9)', content: 'Selected code', reference: { start: 8, end: 21 } };
	const options = { draft: { mode: 'agent', text: 'Explain file.ts (6-9)', contexts: [context] } };
	assert.deepEqual(route.validate(options), options);
	assert.deepEqual(route.validate({ draft: { ...options.draft, contexts: [{ ...context, kind: 'file' }] } }), { draft: { ...options.draft, contexts: [{ ...context, kind: 'file' }] } });
	assert.deepEqual(route.validate({ draft: { ...options.draft, contexts: [{ ...context, kind: 'image' }] } }), { draft: { ...options.draft, contexts: [{ ...context, kind: 'image' }] } });
	for (const reference of [{ start: -1, end: 21 }, { start: 8.5, end: 21 }, { start: 8, end: 22 }, { start: 7, end: 21 }, { start: 8, end: 8 }, null, { start: 8, end: 21, extra: true }]) {
		assert.throws(() => route.validate({ draft: { ...options.draft, contexts: [{ ...context, reference }] } }), /Invalid Agents Window context reference/);
	}
});

test('Agents Window handoff accepts validated inline references for folders, sessions and tool configuration', () => {
	const route = nativeHostIpcRoutes({ openAgentsWindow: async () => { } } as INativeHostMainService).find(route => route.channel === NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL)!;
	for (const kind of ['directory', 'session', 'toolSelection', 'instruction', 'registeredSource']) {
		const context = { id: kind, kind, name: 'context', content: 'snapshot', reference: { start: 7, end: 14 } };
		assert.doesNotThrow(() => route.validate({ draft: { mode: 'agent', text: 'Review context please', contexts: [context] } }));
	}
});


test('the Renderer Host transports shared dialog options, complete results, and cancellation through Main routes', async () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	const { AgentsWindowInvitationState } = await import('../../../chat/common/agentsWindowInvitation.js');
	const { buildOpenSessionLinkUri } = await import('../../../agentHost/common/openSessionLink.js');
	using invitations = new AgentsWindowInvitationState(() => 86_400_000, { editorSessionCount: 0, lastShown: undefined, agentsWindowSessionCount: 0, lastAgentsWindowSessionCreated: undefined });
	let malformedState = false;
	const requests: unknown[] = [];
	let finish!: (result: MessageBoxReturnValue) => void;
	let mainSignal: AbortSignal | undefined;
	let messageShows = 0;
	const window = { id: 7 } as BrowserWindow;
	using dialogs = new DialogMainService({
		showOpenDialog: async (options, owner) => {
			assert.equal(owner, window);
			requests.push(options);
			return { canceled: false, filePaths: ['/one.md', '/two.md'], bookmarks: ['first', 'second'] };
		},
		showSaveDialog: async (options, owner) => {
			assert.equal(owner, window);
			requests.push(options);
			return { canceled: false, filePath: '/report.md', bookmark: 'saved' };
		},
		showMessageBox: async options => {
			messageShows++;
			mainSignal = options.signal;
			return new Promise(resolve => { finish = resolve; });
		},
	});
	let frameStyle: unknown = 'custom';
	let pinListener: ((value: unknown) => void) | undefined;
	const routes = nativeHostIpcRoutes({
		getAgentHostEditorState: () => malformedState ? { ...invitations.getState(), revision: NaN } : invitations.getState(),
		updateAgentHostEditorState: async update => invitations.update(7, update),
		claimAgentsWindowInvitation: resource => invitations.claim(7, resource),
		markAgentsWindowInvitationShown: async id => invitations.markShown(7, id),
		releaseAgentsWindowInvitation: id => invitations.release(7, id),
		getTitleBarStyle: () => frameStyle,
		showOpenDialog: options => dialogs.showOpenDialog(options, window),
		showSaveDialog: options => dialogs.showSaveDialog(options, window),
		performDialogOperation: operation => dialogs.perform(window, operation),
	} as INativeHostMainService);
	const globals: ISandboxGlobals = {
		ipcRenderer: {
			send: () => { throw new Error('Unexpected send'); },
			on: (channel, listener) => {
				assert.equal(channel, WINDOW_ALWAYS_ON_TOP_CHANGED_CHANNEL);
				pinListener = listener;
				return { dispose() { pinListener = undefined; } };
			},
			async invoke(channel, value) {
				const route = routes.find(route => route.channel === channel);
				assert.ok(route);
				return structuredClone(await route.invoke(route.validate(structuredClone(value))));
			},
		},
		ipcMessagePort: { acquire: () => { throw new Error('Unexpected port request'); } },
		process: { platform: process.platform, arch: process.arch },
		webUtils: { getPathForFile: () => '' },
	};
	Object.defineProperty(globalThis, 'ash', { configurable: true, value: globals });
	try {
		const { createNativeHostApi } = await import('../../electron-browser/nativeHostApi.js');
		const mainProcess: IMainProcessService = {
			_serviceBrand: undefined,
			getChannel: () => ({ call: async () => { throw new Error('Unexpected channel call'); }, listen: () => { throw new Error('Unexpected channel event'); } }),
			registerChannel: () => { throw new Error('Unexpected channel registration'); },
		};
		const host = createNativeHostApi(mainProcess);
		const pinEvents: IWindowAlwaysOnTopChangedEvent[] = [];
		const pinSubscription = host.onDidChangeWindowAlwaysOnTop(event => pinEvents.push(event));
		const pinnedWindow = { windowName: 'ash-auxiliary-12345678-1234-1234-1234-123456789abc', alwaysOnTop: true };
		pinListener!(pinnedWindow);
		assert.deepEqual(pinEvents, [pinnedWindow]);
		assert.throws(() => pinListener!({ alwaysOnTop: 'true' }), /Invalid window always-on-top change/);
		pinSubscription.dispose();
		assert.equal(pinListener, undefined);
		const activityResource = buildOpenSessionLinkUri('s', 't', 'local').toJSON();
		await host.updateAgentHostEditorState({ kind: 'request', resource: activityResource, isNewSession: true, requestSequence: 1 });
		await host.updateAgentHostEditorState({ kind: 'sessions', sessions: [{ resource: activityResource, inProgress: true, needsInput: false }] });
		assert.equal((await host.getAgentHostEditorState()).editorSessionCount, 1);
		const invitation = await host.claimAgentsWindowInvitation(activityResource);
		assert.equal(invitation?.windowId, 7);
		assert.deepEqual(invitation?.resource, activityResource);
		await host.markAgentsWindowInvitationShown(invitation!.id);
		assert.deepEqual((await host.getAgentHostEditorState()).lastShown, { timestamp: 86_400_000, editorSessionCount: 1 });
		await host.releaseAgentsWindowInvitation(invitation!.id);
		assert.equal((await host.getAgentHostEditorState()).invitation, undefined);
		malformedState = true;
		await assert.rejects(host.getAgentHostEditorState(), /Invalid editor activity state/);
		malformedState = false;
		assert.equal(await host.getTitleBarStyle(), 'custom');
		frameStyle = 'invalid';
		await assert.rejects(host.getTitleBarStyle(), /Unknown window title bar style/);
		frameStyle = 'custom';
		const open = { title: 'Import', properties: ['openFile', 'multiSelections', 'showHiddenFiles'] as const, securityScopedBookmarks: true };
		const save = { title: 'Export', nameFieldLabel: 'Name', showsTagField: false, properties: ['showOverwriteConfirmation'] as const, securityScopedBookmarks: true };
		assert.deepEqual(await host.showOpenDialog({ ...open, properties: [...open.properties] }), { canceled: false, filePaths: ['/one.md', '/two.md'], bookmarks: ['first', 'second'] });
		assert.deepEqual(await host.showSaveDialog({ ...save, properties: [...save.properties] }), { canceled: false, filePath: '/report.md', bookmark: 'saved' });
		assert.deepEqual(requests, [{ ...open, properties: [...open.properties], defaultPath: undefined }, { ...save, properties: [...save.properties] }]);

		const controller = new AbortController();
		const pending = host.showMessageBox({ message: 'Waiting', buttons: ['Continue', 'Cancel'], cancelId: 1, signal: controller.signal });
		await Promise.resolve();
		await Promise.resolve();
		assert.ok(mainSignal);
		assert.notEqual(mainSignal, controller.signal);
		controller.abort();
		assert.equal(mainSignal.aborted, true);
		finish({ response: 0, checkboxChecked: true });
		assert.deepEqual(await pending, { response: 1, checkboxChecked: false });
		assert.deepEqual(await host.showMessageBox({ message: 'Already cancelled', cancelId: 0, signal: controller.signal }), { response: 0, checkboxChecked: false });
		assert.equal(messageShows, 1);
		const withoutCancelButton = new AbortController();
		const cancellable = host.showMessageBox({ message: 'Waiting without a cancel button', cancelId: -1, signal: withoutCancelButton.signal });
		await Promise.resolve();
		await Promise.resolve();
		withoutCancelButton.abort();
		finish({ response: 0, checkboxChecked: false });
		assert.deepEqual(await cancellable, { response: -1, checkboxChecked: false });
	} finally {
		if (original) Object.defineProperty(globalThis, 'ash', original);
		else Reflect.deleteProperty(globalThis, 'ash');
	}
});

test('dialog boundaries reject legacy requests, non-transferable signals, and malformed results', () => {
	for (const options of [{ message: 'Question', signal: new AbortController().signal }, { message: 'Question', cancelId: 4, buttons: ['Cancel'] }, { message: 'Question', type: 'custom' }]) {
		assert.throws(() => validateNativeDialogOperation({ kind: 'show', id: 1, options }), TypeError);
	}
	assert.throws(() => validateNativeDialogOperation({ kind: 'show', id: 1, request: { kind: 'confirmation', message: 'Question' } }), TypeError);
	assert.throws(() => validateOpenDialogResult(['/one.md']), TypeError);
	assert.throws(() => validateOpenDialogResult({ canceled: false, filePaths: [42] }), TypeError);
	assert.throws(() => validateSaveDialogResult('/report.md'), TypeError);
	assert.throws(() => validateSaveDialogResult({ canceled: 'false', filePath: '/report.md' }), TypeError);
	assert.throws(() => validateMessageBoxResult({ response: 0, checkboxChecked: 'false' }), TypeError);
	assert.deepEqual(validateOpenDialogResult({ canceled: true, filePaths: [] }), { canceled: true, filePaths: [] });
	assert.deepEqual(validateSaveDialogResult({ canceled: true, filePath: '' }), { canceled: true, filePath: '' });
});


test('Agents Window handoff keeps terminal snapshots and inline positions in the same validated context', () => {
	const context = { id: 'terminal', kind: 'terminal', name: 'Terminal: Shell', content: 'Captured output', terminalSnapshot: { text: 'captured', columns: 80 }, reference: { start: 7, end: 22 } };
	const options = { draft: { mode: 'agent', text: 'Review Terminal: Shell ', contexts: [context] } };
	const route = nativeHostIpcRoutes({ openAgentsWindow: async () => { } } as INativeHostMainService).find(route => route.channel === NATIVE_HOST_OPEN_AGENTS_WINDOW_CHANNEL)!;
	assert.deepEqual(route.validate(options), options);
	assert.throws(() => route.validate({ draft: { ...options.draft, contexts: [{ ...context, terminalSnapshot: { text: 'captured', columns: 0 } }] } }), /Invalid terminal snapshot/);
	assert.throws(() => route.validate({ draft: { ...options.draft, contexts: [{ ...context, reference: { start: 0, end: 22 } }] } }), /Invalid Agents Window context reference/);
});

test('invitation IPC binds ownership to trusted windows and normalizes resources before activity updates', async () => {
	const { TrustedIpcRouter } = await import('../../../ipc/electron-main/trustedIpcRouter.js');
	const { AgentsWindowInvitationState } = await import('../../../chat/common/agentsWindowInvitation.js');
	const { buildOpenSessionLinkUri } = await import('../../../agentHost/common/openSessionLink.js');
	const channels = await import('../../common/nativeHost.js');
	const handlers = new Map<string, (event: import('../../../ipc/electron-main/trustedIpcRouter.js').IpcMainInvokeEventLike, params: unknown) => unknown>();
	using router = new TrustedIpcRouter({ handle: (channel, listener) => { handlers.set(channel, listener); }, removeHandler: channel => { handlers.delete(channel); } });
	using state = new AgentsWindowInvitationState(() => 86_400_000, { editorSessionCount: 0, lastShown: undefined, agentsWindowSessionCount: 0, lastAgentsWindowSessionCreated: undefined });
	const target = () => { const frame = { url: 'file:///trusted.html' }; return { webContents: { mainFrame: frame }, allowedEntryUrls: new Set([frame.url]) }; };
	const first = target(); const second = target();
	const routes = (windowId: number) => nativeHostIpcRoutes({
		getAgentHostEditorState: () => state.getState(), updateAgentHostEditorState: async update => state.update(windowId, update),
		claimAgentsWindowInvitation: resource => state.claim(windowId, resource), markAgentsWindowInvitationShown: async id => state.markShown(windowId, id), releaseAgentsWindowInvitation: id => state.release(windowId, id),
	} as INativeHostMainService);
	using firstRegistration = router.register(first, routes(1));
	using secondRegistration = router.register(second, routes(2));
	const call = (owner: typeof first, channel: string, value?: unknown) => handlers.get(channel)!({ sender: owner.webContents, senderFrame: owner.webContents.mainFrame }, structuredClone(value));
	const resource = buildOpenSessionLinkUri('session', 'thread', 'local').toJSON();
	const request = { kind: 'request', resource, isNewSession: true, requestSequence: 1 };
	for (const malformed of [{ ...request, windowId: 2 }, { ...request, isNewSession: 'true' }, { ...request, requestSequence: -1 }, { ...request, requestSequence: NaN }, { ...request, resource: { ...resource, external: 'agent-host-session://local/open?sessionId=other&threadId=t' } }, { kind: 'sessions', sessions: [{ resource, windowId: 2, inProgress: true, needsInput: false }] }, { kind: 'sessions', sessions: new Array(129).fill({ resource, inProgress: true, needsInput: false }) }, { ...request, resource: { ...resource, query: 'sessionId=s&sessionId=other&threadId=t' } }]) {
		assert.throws(() => call(first, channels.AGENT_HOST_EDITOR_UPDATE_CHANNEL, malformed));
	}
	assert.throws(() => call(target(), channels.AGENT_HOST_EDITOR_UPDATE_CHANNEL, request), /Untrusted/);
	assert.throws(() => handlers.get(channels.AGENT_HOST_EDITOR_UPDATE_CHANNEL)!({ sender: first.webContents, senderFrame: { url: 'file:///trusted.html' } }, request), /main frame/);
	assert.deepEqual(state.getState().sessions, []);
	await call(first, channels.AGENT_HOST_EDITOR_UPDATE_CHANNEL, request);
	await call(first, channels.AGENT_HOST_EDITOR_UPDATE_CHANNEL, { kind: 'sessions', sessions: [{ resource, inProgress: true, needsInput: false }] });
	const claim = await call(first, channels.AGENTS_WINDOW_INVITATION_CLAIM_CHANNEL, resource) as import('../../../chat/common/agentsWindowInvitation.js').IAgentsWindowInvitation;
	assert.equal(claim.windowId, 1);
	await call(second, channels.AGENTS_WINDOW_INVITATION_SHOWN_CHANNEL, claim.id);
	await call(second, channels.AGENTS_WINDOW_INVITATION_RELEASE_CHANNEL, claim.id);
	assert.equal(state.getState().lastShown, undefined);
	assert.equal(state.getState().invitation?.id, claim.id);
	await call(first, channels.AGENTS_WINDOW_INVITATION_SHOWN_CHANNEL, claim.id);
	assert.deepEqual(state.getState().lastShown, { timestamp: 86_400_000, editorSessionCount: 1 });
	firstRegistration.dispose();
	assert.throws(() => call(first, channels.AGENTS_WINDOW_INVITATION_RELEASE_CHANNEL, claim.id), /Untrusted/);
});


test('workspace IPC preserves the new-window policy and validates legacy and structured requests', async () => {
	const opened: unknown[] = [];
	const route = nativeHostIpcRoutes({ openWorkspace: async (root, forceNewWindow) => { opened.push({ root, forceNewWindow }); } } as INativeHostMainService).find(route => route.channel === NATIVE_HOST_OPEN_WORKSPACE_CHANNEL)!;
	await route.invoke(route.validate('/workspace'));
	await route.invoke(route.validate({ root: '/clone', forceNewWindow: true }));
	assert.deepEqual(opened, [{ root: '/workspace', forceNewWindow: false }, { root: '/clone', forceNewWindow: true }]);
	for (const value of ['', { root: '/clone', forceNewWindow: 'true' }, { root: '/clone', other: true }, { root: '/clone\0' }]) {
		assert.throws(() => route.validate(value), /Invalid workspace request/);
	}
	assert.equal(opened.length, 2);
});
