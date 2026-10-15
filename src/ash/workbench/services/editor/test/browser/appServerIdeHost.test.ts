import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { TestUriIdentityServices } from '../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { AppServerProtocolClient } from '../../../../../platform/agentHost/browser/appServerProtocolClient.js';
import { createTestInitializeResult } from '../../../../../platform/agentHost/test/common/testAppServerProtocol.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, type AppServerTransport } from '../../../../../platform/agentHost/common/appServerTransport.js';
import { WorkspaceContextService } from '../../../workspaces/browser/workspaceContextService.js';
import { IWorkingCopyService } from '../../../workingCopy/common/workingCopyService.js';
import { BrowserWorkingCopyService } from '../../../workingCopy/browser/browserWorkingCopyService.js';
import { IEditorGroupsService } from '../../common/editorGroupsService.js';
import { IEditorService, type EditorOpenOptions } from '../../common/editorService.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { isDiffEditorInput } from '../../../../common/editor/diffEditorInput.js';
import { INativeHostService } from '../../../../common/services.js';
import type { INativeHostApi, IOpenAgentsWindowOptions } from '../../../../../platform/native/common/nativeHost.js';
import { AppServerIdeHost } from '../../browser/appServerIdeHost.js';
import type { IdeHostRequest } from '../../../../../../../.build/protocol/typescript/index.js';

class IdeTransport implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
	private readonly replies = new Map<string, DeferredPromise<Record<string, unknown>>>();
	readonly registered = new DeferredPromise<void>();
	readonly requests: Record<string, unknown>[] = [];
	private next = 0;
	on(event: string, listener: (value: unknown) => void): void { const listeners = this.listeners.get(event) ?? new Set(); listeners.add(listener); this.listeners.set(event, listeners); }
	off(event: string, listener: (value: unknown) => void): void { this.listeners.get(event)?.delete(listener); }
	private emit(event: string, value: unknown): void { for (const listener of this.listeners.get(event) ?? []) listener(value); }
	private frame(value: Record<string, unknown>): void { this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', ...value }) }); }
	send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) { this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: 1, workspaceId: 'project', workspaceRoot: '/project' }); return; }
		if (event !== WEB_APP_SERVER_FRAME_EVENT) return;
		const frame = JSON.parse((payload as { frame: string; }).frame) as Record<string, unknown>;
		if (frame.method === 'initialize') { this.frame({ id: frame.id, result: createTestInitializeResult() }); return; }
		if (frame.method === 'ide/request') {
			this.requests.push(frame);
			const params = frame.params as { type: string; title?: string; roots?: string[]; };
			this.frame({ id: frame.id, result: params.type === 'register' ? { type: 'registered', window: { id: '01234567890123456789012345678901', title: params.title, roots: params.roots } } : { type: 'connected', window: null } });
			if (params.type === 'register') void this.registered.complete();
		} else if (typeof frame.id === 'string') {
			void this.replies.get(frame.id)?.complete(frame);
			this.replies.delete(frame.id);
		}
	}
	call(params: IdeHostRequest): Promise<Record<string, unknown>> {
		const id = `ide-test-${++this.next}`;
		const result = new DeferredPromise<Record<string, unknown>>();
		this.replies.set(id, result);
		this.frame({ id, method: 'ide/hostRequest', params });
		return result.p;
	}
}

async function fixture() {
	const lifetime = new DisposableStore();
	try {
		const services = lifetime.add(new TestUriIdentityServices());
		const resource = URI.file('/project/lib.rs');
		const model = lifetime.add(new TextModel('unsaved selection', { resource }));
		const workspace = lifetime.add(new WorkspaceContextService({ id: 'project', name: 'Project', folders: [{ id: 'folder', name: 'Project', index: 0, uri: URI.file('/project') }] }));
		const workingCopies = lifetime.add(services.createInstance(BrowserWorkingCopyService));
		lifetime.add(workingCopies.register({ resource, backupKind: 'text', isDirty: true, hasExternalChange: false, onDidChangeDirty: Event.None, onDidChangeExternalChange: Event.None, onDidChangeContent: Event.None, backup: () => model.getValue(), restoreBackup: () => assert.fail('context must not mutate the model'), save: async () => assert.fail('context must not save'), saveAs: async () => assert.fail('context must not save'), revert: async () => assert.fail('context must not revert'), ...toDisposable(() => { }) }));
		services.registerInstance(IWorkspaceContextService, workspace);
		services.registerInstance(IWorkingCopyService, workingCopies);
		let selection = new Selection(1, 1, 1, 8);
		services.registerInstance(ICodeEditorService, { getActiveCodeEditor: () => ({ getModel: () => model, getSelections: () => [selection] } as unknown as ICodeEditor) } as ICodeEditorService);
		services.registerInstance(IEditorGroupsService, { groups: [{ inputs: [{ resource }, { resource: URI.file('/other/private.rs') }] }] } as unknown as IEditorGroupsService);
		const opened: Array<{ input: IResourceEditorInput; options?: EditorOpenOptions; }> = [];
		let open: () => Promise<void> = async () => { };
		services.registerInstance(IEditorService, { onDidActiveEditorChange: Event.None, openEditor: async (input, options) => { opened.push({ input, options }); await open(); } } as IEditorService);
		const conversations: IOpenAgentsWindowOptions[] = [];
		let openConversation: () => Promise<void> = async () => { };
		services.registerInstance(INativeHostService, {
			openAgentsWindow: async options => {
				conversations.push(options!); await openConversation();
			}
		} as INativeHostApi);
		const transport = new IdeTransport();
		const client = new AppServerProtocolClient(transport);
		lifetime.add(toDisposable(() => client.dispose()));
		await client.connect();
		const host = lifetime.add(services.createInstance(AppServerIdeHost, client));
		await transport.registered.p;
		return { lifetime, transport, host, workspace, model, opened, conversations, setOpenConversation: (next: () => Promise<void>) => { openConversation = next; }, setSelection: (next: Selection) => { selection = next; }, setOpen: (next: () => Promise<void>) => { open = next; } };
	} catch (error) { lifetime.dispose(); throw error; }
}

test('IDE registration and context use the live editor model and filter unrelated files', async () => {
	const f = await fixture();
	using cleanup = f.lifetime;
	const registration = f.transport.requests[0]!.params as { windowKey: string; };
	assert.match(registration.windowKey, /^[0-9a-f]{32}$/i);
	assert.deepEqual(f.transport.requests[0]!.params, { type: 'register', title: 'Project', roots: ['/project'], windowKey: registration.windowKey });
	assert.equal(await f.host.readTerminalWindowKey(), registration.windowKey);
	const first = await f.transport.call({ type: 'context', roots: ['/project'] });
	assert.deepEqual(first.result, { type: 'context', context: { activeFile: { path: '/project/lib.rs', version: 1, selections: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 8, text: 'unsaved', truncated: false }] }, openTabs: ['/project/lib.rs'], dirtyFiles: ['/project/lib.rs'] } });
	f.model.setValue('changed selection');
	const second = await f.transport.call({ type: 'context', roots: ['/project'] });
	const result = second.result as { context: { activeFile: { version: number; selections: Array<{ text: string; }>; }; }; };
	assert.equal(result.context.activeFile.version, f.model.getVersionId());
	assert.equal(result.context.activeFile.selections[0]!.text, 'changed');
	const excluded = await f.transport.call({ type: 'context', roots: ['/other'] });
	assert.deepEqual(excluded.result, { type: 'context', context: { activeFile: null, openTabs: [], dirtyFiles: [] } });
});

test('IDE display uses the existing file and diff editor owners and rejects another workspace', async () => {
	const f = await fixture();
	using cleanup = f.lifetime;
	assert.deepEqual((await f.transport.call({ type: 'openFile', path: '/project/lib.rs', line: 4 })).result, { type: 'opened' });
	assert.equal(f.opened[0]!.input.resource.fsPath, '/project/lib.rs');
	assert.equal(f.opened[0]!.options!.selection!.startLineNumber, 4);
	assert.deepEqual((await f.transport.call({ type: 'openReview', original: '/project/old.rs', modified: '/project/lib.rs' })).result, { type: 'opened' });
	assert.ok(isDiffEditorInput(f.opened[1]!.input));
	assert.ok((await f.transport.call({ type: 'openFile', path: '/other/private.rs', line: null })).error);
	assert.equal(f.opened.length, 2);
});

test('disposing the IDE host withdraws discovery and cancels a late display result', async () => {
	const f = await fixture();
	using cleanup = f.lifetime;
	const entered = new DeferredPromise<void>();
	const finish = new DeferredPromise<void>();
	f.setOpen(async () => { void entered.complete(); await finish.p; });
	const pending = f.transport.call({ type: 'openFile', path: '/project/lib.rs', line: null });
	await entered.p;
	f.host.dispose();
	void finish.complete();
	assert.ok((await pending).error);
	assert.equal((f.transport.requests.at(-1)!.params as { type: string; }).type, 'unregister');
	assert.equal(await f.host.readTerminalWindowKey(), undefined);
});


test('IDE selection context marks truncation and preserves complete Unicode characters', async () => {
	const f = await fixture();
	using cleanup = f.lifetime;
	f.model.setValue('🙂'.repeat(40_001));
	f.setSelection(new Selection(1, 1, 1, f.model.getLineMaxColumn(1)));
	const response = await f.transport.call({ type: 'context', roots: ['/project'] });
	const result = response.result as { context: { activeFile: { selections: Array<{ text: string; truncated: boolean; }>; }; }; };
	assert.equal(result.context.activeFile.selections[0]!.text, '🙂'.repeat(40_000));
	assert.equal(result.context.activeFile.selections[0]!.truncated, true);
});


test('desktop handoff waits for the existing window service to acknowledge the exact conversation', async () => {
	const f = await fixture();
	using cleanup = f.lifetime;
	const entered = new DeferredPromise<void>();
	const finish = new DeferredPromise<void>();
	f.setOpenConversation(async () => { void entered.complete(); await finish.p; });
	let acknowledged = false;
	const pending = f.transport.call({ type: 'openConversation', sessionId: 'session', threadId: 'thread' });
	void pending.then(() => { acknowledged = true; });
	await entered.p;
	assert.equal(acknowledged, false);
	assert.deepEqual(f.conversations, [{ conversation: { sessionId: 'session', threadId: 'thread' } }]);
	assert.equal(f.opened.length, 0);
	void finish.complete();
	assert.deepEqual((await pending).result, { type: 'opened' });
});

test('desktop handoff does not acknowledge failed navigation or a disposed source window', async () => {
	const f = await fixture();
	using cleanup = f.lifetime;
	f.setOpenConversation(async () => { throw new Error('Session unavailable'); });
	assert.ok((await f.transport.call({ type: 'openConversation', sessionId: 'session', threadId: 'thread' })).error);
	const entered = new DeferredPromise<void>();
	const finish = new DeferredPromise<void>();
	f.setOpenConversation(async () => { void entered.complete(); await finish.p; });
	const pending = f.transport.call({ type: 'openConversation', sessionId: 'session', threadId: 'thread' });
	await entered.p;
	f.host.dispose();
	void finish.complete();
	assert.ok((await pending).error);
});
