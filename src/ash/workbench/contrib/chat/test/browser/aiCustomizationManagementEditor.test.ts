import assert from 'node:assert/strict';
import { test } from 'mocha';
import { mock } from 'node:test';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { formatNlsMessage, resetNlsResolver } from '../../../../../nls.js';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { ILocalizationService } from '../../../../services/localization/common/localizationService.js';
import { WorkbenchLocalizationService } from '../../../../services/localization/browser/workbenchLocalizationService.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IAppServerHookApi, IAppServerSkillApi, type HookSource } from '../../../../../platform/agentHost/common/appServerApi.js';
import { createDisconnectedRendererApi } from '../../../../../platform/agentHost/browser/rendererApi.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { darkColorTheme } from '../../../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IAppServerRemoteAgentService } from '../../../../services/remote/common/appServerRemoteAgentService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { WorkspaceContextService } from '../../../../services/workspaces/browser/workspaceContextService.js';
import type { ITextFileSaveEvent } from '../../../../services/textfile/common/textFileService.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { IWorkbenchHostService } from '../../../../services/host/common/workbenchHostService.js';
import { IPromptsService } from '../../common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../common/promptSyntax/service/promptsServiceImpl.js';
import { AICustomizationManagementEditor } from '../../browser/aiCustomization/aiCustomizationManagementEditor.js';

const document = browserEnvironment.window.document;
const source: HookSource = { namespace: 'directory:fixture', configPath: '/fixture/.ash/config.toml', hooks: [{ id: 'directory:fixture:hook:test', event: 'preToolUse', enabled: false, program: '/synthetic/check', args: ['two words'], toolNames: [] }] };

function setup(resources: DisposableStore, read: () => Promise<readonly HookSource[]>, localization: ILocalizationService = { whenReady: Promise.resolve(), translate: (_bundle, _key, fallback, parameters) => formatNlsMessage(fallback, parameters) }) {
	const services = resources.add(new InstantiationService());
	const keys = resources.add(new ContextKeyService());
	const views = resources.add(new BrowserContextViewService(document.body));
	const theme = resources.add(new TestThemeService(darkColorTheme));
	const workspace = resources.add(new WorkspaceContextService({ id: 'fixture', folders: [{ id: 'folder', name: 'fixture', index: 0, uri: URI.file('/fixture') }] }));
	const saved = resources.add(new Emitter<ITextFileSaveEvent>());
	const hooks = { onDidChangeHooks: Event.None, list: read };
	const remote = { connection: { kind: 'local' as const, generation: 1 }, connectionState: 'connected' as const, onDidChangeConnection: Event.None, onDidChangeConnectionState: Event.None, reconnect: async () => ({ kind: 'alreadyConnected' as const }), rollbackRuntime: async () => ({ kind: 'cancelled' as const }) };
	services.registerInstance(IAppServerHookApi, hooks);
	services.registerInstance(IAppServerSkillApi, createDisconnectedRendererApi().skills);
	services.registerInstance(IWorkbenchHostService, { downloadText: () => { throw new Error('Unexpected download'); } });
	services.registerSingleton(IPromptsService, () => services.createInstance(PromptsService));
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IAppServerRemoteAgentService, remote);
	services.registerInstance(IChatSessionNavigationService, { getActiveConversation: () => undefined } as IChatSessionNavigationService);
	services.registerInstance(ILocalizationService, localization);
	services.registerInstance(IContextViewService, views);
	services.registerInstance(IContextKeyService, keys);
	services.registerInstance(IAccessibleViewService, { ...toDisposable(() => { }), getOpenAriaHint: () => undefined, show: () => false, disableHint: async () => { }, showAccessibleViewHelp: () => { } });
	services.registerInstance(IThemeService, theme);
	services.registerInstance(IStorageService, { onWillSaveState: Event.None } as IStorageService);
	assert.throws(() => services.createInstance(AICustomizationManagementEditor), /textFileService/u);
	services.registerInstance(ITextFileService, { onDidSave: saved.event, onDidChangeFiles: Event.None, resolve: async () => assert.fail('Management must not resolve text files itself'), save: async () => assert.fail('Management must not persist text files itself') });
	const pane = resources.add(services.createInstance(AICustomizationManagementEditor));
	const container = document.createElement('main');
	document.body.append(container);
	resources.add(toDisposable(() => container.remove()));
	pane.create(container);
	return { pane, container, workspace, saved };
}

async function waitForHooks(container: HTMLElement): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		if (container.querySelector('section')?.getAttribute('aria-busy') === 'false') return;
		await Promise.resolve();
	}
	assert.fail('Hook management did not finish loading');
}

test('Hook management renders source-owned event descriptions and status through the Chinese window catalog', async () => {
	initializeTestLocalization('zh-CN');
	try {
		using resources = new DisposableStore();
		const localization = resources.add(new WorkbenchLocalizationService());
		const { pane, container } = setup(resources, async () => [source], localization);
		pane.setVisible(true);
		await waitForHooks(container);
		assert.match(container.querySelector('[role="status"]')?.textContent ?? '', /^\d+ 种事件 · 已配置 1 个 Hook$/u);
		assert.ok(container.querySelector('[data-hook-event="preToolUse"]')?.textContent?.includes('工具执行前。'));
	} finally { resetNlsResolver(); }
});

test('Hook management refreshes a saved configuration through the owning text-file event, preserving disclosure and search', async () => {
	using resources = new DisposableStore();
	let reads = 0;
	const { pane, container, saved } = setup(resources, async () => { reads++; return [source]; });
	pane.setVisible(true);
	await waitForHooks(container);
	const row = container.querySelector<HTMLDetailsElement>(`[data-hook-id="${source.hooks[0].id}"]`)!;
	assert.ok(row);
	row.open = true;
	const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
	search.value = 'synthetic';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		saved.fire({ resource: URI.file('/fixture/unrelated.toml'), content: '', revision: '1' });
		mock.timers.tick(100);
		assert.equal(reads, 1);
		saved.fire({ resource: URI.file(source.configPath), content: '', revision: '2' });
		mock.timers.tick(100);
		await waitForHooks(container);
		assert.equal(reads, 2);
		assert.equal(container.querySelector(`[data-hook-id="${source.hooks[0].id}"]`), row);
		assert.equal(row.open, true);
		assert.equal(search.value, 'synthetic');
		assert.equal(container.querySelector('section')!.getAttribute('aria-busy'), 'false');
		pane.setVisible(false);
		saved.fire({ resource: URI.file(source.configPath), content: '', revision: '3' });
		mock.timers.tick(100);
		assert.equal(reads, 2);
	} finally { mock.timers.reset(); }
});

test('Hook management rejects a late response after its workspace changes and reports the current failure', async () => {
	using resources = new DisposableStore();
	const pending = new DeferredPromise<readonly HookSource[]>();
	let reads = 0;
	const { pane, container, workspace } = setup(resources, () => ++reads === 1 ? pending.p : Promise.reject(new Error('current read failed')));
	pane.setVisible(true);
	workspace.updateWorkspace({ id: 'next', folders: [] });
	await Promise.resolve();
	await pending.complete([source]);
	await Promise.resolve();
	assert.match(container.querySelector('[role="status"]')!.textContent!, /current read failed/u);
	assert.equal(container.querySelectorAll('.ash-hooks-declaration').length, 0);
	assert.equal(container.querySelector('section')!.getAttribute('aria-busy'), 'false');
});
