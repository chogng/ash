import assert from 'node:assert/strict';
import { test } from 'mocha';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { IAppServerHookApi, IAppServerSkillApi, type HookSource } from '../../../../../platform/agentHost/common/appServerApi.js';
import { createDisconnectedRendererApi } from '../../../../browser/rendererApi.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../../../services/workspaces/browser/workspaceContextService.js';
import { TestQuickInputService } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IAppServerRemoteAgentService } from '../../../../services/remote/common/appServerRemoteAgentService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkbenchHostService } from '../../../../services/host/common/workbenchHostService.js';
import { IPromptsService } from '../../common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../common/promptSyntax/service/promptsServiceImpl.js';
import { openHookConfiguration, showConfigureHooksQuickPick } from '../../browser/promptSyntax/hookActions.js';

const document = browserEnvironment.window.document;

function acceptFirst(): void {
	const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!;
	assert.ok(input);
	input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

for (const change of ['workspace', 'dismiss'] as const) test(`Configure Hooks ignores a delayed catalog after ${change}`, async () => {
	using resources = new DisposableStore();
	const services = resources.add(new InstantiationService());
	const context = resources.add(new ContextKeyService());
	const quick = resources.add(new TestQuickInputService({ container: document.body, contextKeyService: context }));
	const workspace = resources.add(new WorkspaceContextService({ id: 'original', folders: [{ id: 'folder', name: 'fixture', index: 0, uri: URI.file('/fixture') }] }));
	const pending = new DeferredPromise<readonly HookSource[]>();
	const started = new DeferredPromise<void>();
	const errors: unknown[] = [];
	const opened: unknown[] = [];
	services.registerInstance(IAppServerSkillApi, createDisconnectedRendererApi().skills);
	services.registerInstance(IWorkbenchHostService, { downloadText: () => { throw new Error('Unexpected download'); } });
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IQuickInputService, quick);
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IAppServerHookApi, { onDidChangeHooks: Event.None, list: () => { void started.complete(); return pending.p; } });
	services.registerInstance(IAppServerRemoteAgentService, { connection: { kind: 'local', generation: 1 }, connectionState: 'connected', onDidChangeConnection: Event.None, onDidChangeConnectionState: Event.None, reconnect: async () => ({ kind: 'alreadyConnected' }), rollbackRuntime: async () => ({ kind: 'cancelled' }) });
	services.registerInstance(IChatSessionNavigationService, { getActiveConversation: () => undefined } as IChatSessionNavigationService);
	services.registerInstance(INotificationService, { error: error => { errors.push(error); } } as INotificationService);
	services.registerInstance(IEditorService, { openEditor: async input => { opened.push(input); } } as IEditorService);
	services.registerInstance(IFileService, { createDirectory: async () => { }, createFile: async () => { } } as unknown as IFileService);
	const configuring = services.invokeFunction(showConfigureHooksQuickPick);
	acceptFirst();
	await started.p;
	if (change === 'workspace') workspace.updateWorkspace({ id: 'original', folders: [{ id: 'folder', name: 'changed', index: 0, uri: URI.file('/different') }] });
	else quick.currentQuickInput!.hide();
	await pending.complete([]);
	await configuring;
	assert.deepEqual(opened, []);
	assert.deepEqual(errors, []);
	assert.equal(quick.currentQuickInput, undefined);
});


test('Opening a Hook configuration cannot create or focus the old file after a workspace switch during IO', async () => {
	using resources = new DisposableStore();
	const services = resources.add(new InstantiationService());
	const workspace = resources.add(new WorkspaceContextService({ id: 'fixture', folders: [{ id: 'folder', name: 'fixture', index: 0, uri: URI.file('/fixture') }] }));
	const pending = new DeferredPromise<void>();
	const calls: string[] = [];
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IAppServerRemoteAgentService, { connection: { kind: 'local', generation: 1 } } as IAppServerRemoteAgentService);
	services.registerInstance(IEditorService, { openEditor: async () => { calls.push('editor'); } } as unknown as IEditorService);
	services.registerInstance(IFileService, { createDirectory: () => { calls.push('directory'); return pending.p; }, createFile: async () => { calls.push('file'); } } as unknown as IFileService);
	const opening = services.invokeFunction(openHookConfiguration, { configPath: '/fixture/.ash/config.toml', namespace: 'directory:fixture' });
	workspace.updateWorkspace({ id: 'fixture', folders: [] });
	await pending.complete();
	await assert.rejects(opening, isCancellationError);
	assert.deepEqual(calls, ['directory']);
});


test('Opening a generic remote Hook configuration preserves its owning authority through file IO and the editor', async () => {
	using resources = new DisposableStore();
	const services = resources.add(new InstantiationService());
	const root = URI.parse('ash-remote://fixture-cloud/fixture');
	const workspace = resources.add(new WorkspaceContextService({ id: 'fixture', folders: [{ id: 'folder', name: 'fixture', index: 0, uri: root }] }));
	const calls: string[] = [];
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IAppServerRemoteAgentService, { connection: { kind: 'remote', generation: 1, authority: 'fixture-cloud' } } as IAppServerRemoteAgentService);
	services.registerInstance(IEditorService, { openEditor: async input => { calls.push(`editor:${input.resource}`); } } as IEditorService);
	services.registerInstance(IFileService, { createDirectory: async (resource: URI) => { calls.push(`directory:${resource}`); }, createFile: async (resource: URI) => { calls.push(`file:${resource}`); } } as unknown as IFileService);
	await services.invokeFunction(openHookConfiguration, { configPath: '/fixture/.ash/config.toml', namespace: 'directory:fixture' });
	assert.deepEqual(calls, ['directory:ash-remote://fixture-cloud/fixture/.ash', 'file:ash-remote://fixture-cloud/fixture/.ash/config.toml', 'editor:ash-remote://fixture-cloud/fixture/.ash/config.toml']);
});
