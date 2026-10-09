import { TestUriIdentityServices } from '../../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { operatingSystem, OperatingSystem } from '../../../../../../base/common/platform.js';
import { BrowserPathService } from '../../../../../services/path/browser/pathService.js';
import { createDisconnectedRendererApi } from '../../../../../../platform/agentHost/browser/rendererApi.js';
import type { IResourceEditorInput } from '../../../../../common/editor.js';
import { isWindows } from '../../../../../../base/common/platform.js';
import { Registry } from '../../../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../../../platform/configuration/common/configurationRegistry.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { ILabelService, LabelService } from '../../../../../../platform/label/common/labelService.js';
import { IWorkspaceContextService, type IWorkspace } from '../../../../../../platform/workspace/common/workspace.js';
import { BrowserWorkingCopyService } from '../../../../../services/workingCopy/browser/browserWorkingCopyService.js';
import { IWorkingCopyService, type IWorkingCopy } from '../../../../../services/workingCopy/common/workingCopyService.js';
import { WorkspaceContextService } from '../../../../../services/workspaces/browser/workspaceContextService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { ILocalizationService } from '../../../../../services/localization/common/localizationService.js';
import { WorkbenchLocalizationService } from '../../../../../services/localization/browser/workbenchLocalizationService.js';
import { initializeTestLocalization } from '../../../../../services/localization/test/common/localizationTestUtils.js';
import type { IEditorGroup, IEditorGroupsContainer } from '../../../../../services/editor/common/editorGroupsService.js';
import type { EditorGroupChangeEvent } from '../../../../../services/editor/common/editorState.js';
import { WindowTitle } from '../../windowTitle.js';

const uriIdentityServices = new TestUriIdentityServices();
suiteTeardown(() => uriIdentityServices.dispose());

interface TestContext {
	readonly dom: JSDOM;
	readonly services: InstantiationService;
	readonly workspace: WorkspaceContextService;
	readonly workingCopies: BrowserWorkingCopyService;
	readonly labels: LabelService;
	readonly editors: TestEditorService;
	readonly configuration: InMemoryConfigurationService;
	readonly contextKeys: ContextKeyService;
}

function createContext(resources: DisposableStore): TestContext {
	const dom = new JSDOM('<!doctype html><title>Previous title</title>');
	resources.add(toDisposable(() => dom.window.close()));
	const services = resources.add(new InstantiationService());
	const workspace = resources.add(new WorkspaceContextService({ id: 'test', folders: [] }));
	const workingCopies = resources.add(uriIdentityServices.createInstance(BrowserWorkingCopyService));
	const labels = resources.add(createTestLabelService(workspace));
	const editors = resources.add(new TestEditorService());
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IWorkingCopyService, workingCopies);
	services.registerInstance(ILabelService, labels);
	const configuration = resources.add(new InMemoryConfigurationService());
	const contextKeys = resources.add(new ContextKeyService());
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextKeyService, contextKeys);
	services.registerInstance(ILocalizationService, { whenReady: Promise.resolve(), translate: (_bundle, _key, fallback) => fallback });
	return { dom, services, workspace, workingCopies, labels, editors, configuration, contextKeys };
}

test('WindowTitle replaces the startup title and follows workspace changes in each product', () => {
	for (const product of ['Ash Code', 'Embedded Ash']) {
		using resources = new DisposableStore();
		const context = createContext(resources);
		resources.add(context.services.createInstance(WindowTitle, context.dom.window as unknown as Window, product, context.editors));
		assert.equal(context.dom.window.document.title, product);
		context.workspace.updateWorkspace({ id: 'project', folders: [{ id: 'root', index: 0, name: '研究项目', uri: URI.file('/project') }] });
		assert.equal(context.dom.window.document.title, `研究项目 — ${product}`);
		context.workspace.updateWorkspace({ id: 'multi', name: 'Research', configuration: URI.file('/research.ash-workspace'), folders: [] });
		assert.equal(context.dom.window.document.title, `Research — ${product}`);
		context.workspace.updateWorkspace({ id: 'empty', folders: [] });
		assert.equal(context.dom.window.document.title, product);
	}
});

test('WindowTitle follows active resources, labels, dirty registrations, save and unregister', async () => {
	using resources = new DisposableStore();
	const context = createContext(resources);
	resources.add(context.services.createInstance(WindowTitle, context.dom.window as unknown as Window, 'Ash Code', context.editors));
	const input = { resource: URI.file('/project/draft.ts'), label: '草稿.ts', onDidChangeLabel: resources.add(new Emitter<void>()).event };
	await context.editors.openEditor(input);
	assert.equal(context.dom.window.document.title, '草稿.ts — Ash Code');
	const copy = resources.add(new TestWorkingCopy(input.resource));
	copy.setDirty(true);
	const registration = resources.add(context.workingCopies.register(copy));
	assert.equal(context.dom.window.document.title, '● 草稿.ts — Ash Code');
	await copy.save(new AbortController().signal);
	assert.equal(context.dom.window.document.title, '草稿.ts — Ash Code');
	copy.setDirty(true);
	registration.dispose();
	assert.equal(context.dom.window.document.title, '草稿.ts — Ash Code');
	await context.editors.openEditor({ resource: URI.file('/project/saved.ts') });
	assert.equal(context.dom.window.document.title, 'saved.ts — Ash Code');
	await context.editors.openEditor({ resource: URI.parse('untitled:/Untitled-1'), label: 'Untitled-1' });
	assert.equal(context.dom.window.document.title, 'Untitled-1 — Ash Code');
	context.editors.close();
	assert.equal(context.dom.window.document.title, 'Ash Code');
});

test('WindowTitle releases the previous editor label and all subscriptions on disposal', async () => {
	using resources = new DisposableStore();
	const context = createContext(resources);
	const labelChanged = resources.add(new Emitter<void>());
	const input = { resource: URI.file('/draft.ts'), label: 'Draft', onDidChangeLabel: labelChanged.event };
	await context.editors.openEditor(input);
	const title = resources.add(context.services.createInstance(WindowTitle, context.dom.window as unknown as Window, 'Ash Code', context.editors));
	input.label = 'Renamed';
	labelChanged.fire();
	assert.equal(context.dom.window.document.title, 'Renamed — Ash Code');
	context.editors.close();
	assert.equal(labelChanged.hasListeners(), false);
	title.dispose();
	context.dom.window.document.title = 'Next owner';
	await context.editors.openEditor(input);
	context.workspace.updateWorkspace({ id: 'new', folders: [], name: 'New workspace' });
	assert.equal(context.dom.window.document.title, 'Next owner');
	assert.equal(context.editors.hasListeners, false);
});

test('WindowTitle keeps main and auxiliary editor scopes independent', async () => {
	using resources = new DisposableStore();
	const context = createContext(resources);
	const popup = new JSDOM('<!doctype html>');
	resources.add(toDisposable(() => popup.window.close()));
	const scope = resources.add(context.services.createChild());
	const popupEditors = resources.add(new TestEditorService());
	resources.add(context.services.createInstance(WindowTitle, context.dom.window as unknown as Window, 'Ash Code', context.editors));
	const popupTitle = resources.add(scope.createInstance(WindowTitle, popup.window as unknown as Window, 'Ash Code', popupEditors));
	await context.editors.openEditor({ resource: URI.file('/main.ts') });
	await popupEditors.openEditor({ resource: URI.file('/detached.ts') });
	assert.deepEqual([context.dom.window.document.title, popup.window.document.title], ['main.ts — Ash Code', 'detached.ts — Ash Code']);
	const workspace: IWorkspace = { id: 'shared', folders: [], name: 'Shared workspace' };
	context.workspace.updateWorkspace(workspace);
	assert.deepEqual([context.dom.window.document.title, popup.window.document.title], ['main.ts — Shared workspace — Ash Code', 'detached.ts — Shared workspace — Ash Code']);
	popupTitle.dispose();
	assert.equal(popupEditors.hasListeners, false);
	assert.equal(context.editors.hasListeners, true);
});

test('WindowTitle rejects creation without its required services', () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(WindowTitle, {} as Window, 'Ash Code', {} as IEditorGroupsContainer), /Unknown service: workspaceContextService/);
});

test('WindowTitle renders path variables and updates templates, separators and context values live', async () => {
	using resources = new DisposableStore();
	const context = createContext(resources);
	context.workspace.updateWorkspace({ id: 'project', folders: [{ id: 'root', index: 0, name: 'Project', uri: URI.file('/project') }] });
	await context.editors.openEditor({ resource: URI.file('/project/src/main.ts') });
	const title = resources.add(context.services.createInstance(WindowTitle, context.dom.window as unknown as Window, 'Ash Code', context.editors));
	await context.configuration.updateValue('window.title', '${activeEditorMedium}${separator}${activeFolderShort}${separator}${folderName}${separator}${folderPath}${separator}${rootPath}');
	assert.equal(title.value, 'src/main.ts — src — Project — /project — /project');
	await context.configuration.updateValue('window.title', '${branch}${separator}${activeEditorShort}${separator}${appName}');
	await context.configuration.updateValue('window.titleSeparator', ' | ');
	context.contextKeys.setContext('git.branch', 'feature/title');
	title.registerVariables([{ name: 'branch', contextKey: 'git.branch' }]);
	assert.equal(title.value, 'feature/title | main.ts | Ash Code');
	context.contextKeys.setContext('git.branch', 'main');
	assert.equal(title.value, 'main | main.ts | Ash Code');
	context.contextKeys.removeContext('git.branch');
	assert.equal(title.value, 'main.ts | Ash Code');
	title.updateProperties({ prefix: '🔴', isAdmin: true });
	assert.equal(title.value, `🔴 main.ts | Ash Code ${isWindows ? '[Administrator]' : '[Superuser]'}`);
	title.updateProperties({ prefix: '' });
	assert.equal(title.value, `main.ts | Ash Code ${isWindows ? '[Administrator]' : '[Superuser]'}`);
	title.dispose();
	context.dom.window.document.title = 'Next owner';
	await context.configuration.updateValue('window.title', '${appName}');
	context.contextKeys.setContext('git.branch', 'next');
	assert.equal(context.dom.window.document.title, 'Next owner');
});

test('WindowTitle uses the selected Chinese language for administrator decoration', () => {
	initializeTestLocalization('zh-CN');
	try {
		using resources = new DisposableStore();
		const context = createContext(resources);
		const translatedServices = resources.add(context.services.createChild());
		translatedServices.registerInstance(ILocalizationService, resources.add(new WorkbenchLocalizationService()));
		const title = resources.add(translatedServices.createInstance(WindowTitle, context.dom.window as unknown as Window, 'Ash Code', context.editors));
		title.updateProperties({ isAdmin: true });
		assert.equal(title.value, `Ash Code ${isWindows ? '[管理员]' : '[超级用户]'}`);
		const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
		assert.equal(registry.getConfiguration('window.title')?.setting?.title, '窗口标题');
		assert.equal(registry.getConfiguration('window.titleSeparator')?.setting?.title, '窗口标题分隔符');
	} finally {
		initializeTestLocalization('en');
	}
});

class TestEditorService extends Disposable implements IEditorGroupsContainer {
	private readonly activeChanged = this._register(new Emitter<EditorGroupChangeEvent>());
	public readonly onDidChangeActiveGroup = Event.None;
	public readonly activeGroup: IEditorGroup;
	constructor() {
		super();
		const owner = this;
		this.activeGroup = {
			get activeInput() { return owner.activeEditor; },
			onDidChangeEditors: this.activeChanged.event,
		} as IEditorGroup;
	}
	public readonly onDidVisibleEditorsChange = Event.None;
	public activeEditor: IResourceEditorInput | undefined;
	public get visibleEditors(): readonly IResourceEditorInput[] { return this.activeEditor ? [this.activeEditor] : []; }
	public get hasListeners(): boolean { return this.activeChanged.hasListeners(); }
	public async openEditor(input: IResourceEditorInput): Promise<void> { this.activeEditor = input; this.activeChanged.fire({ kind: 'activeEditorChanged', editor: undefined }); }
	public close(): void { this.activeEditor = undefined; this.activeChanged.fire({ kind: 'activeEditorChanged', editor: undefined }); }
	public focusActiveEditor(): void { }
}

class TestWorkingCopy extends Disposable implements IWorkingCopy {
	private readonly dirtyChanged = this._register(new Emitter<void>());
	public readonly onDidChangeDirty = this.dirtyChanged.event;
	public readonly onDidChangeExternalChange = Event.None;
	public readonly onDidChangeContent = Event.None;
	public readonly hasExternalChange = false;
	public readonly backupKind = 'text';
	public isDirty = false;
	constructor(public readonly resource: URI) { super(); }
	public setDirty(value: boolean): void { this.isDirty = value; this.dirtyChanged.fire(); }
	public backup(): string { return ''; }
	public restoreBackup(): void { }
	public async save(_signal: AbortSignal): Promise<void> { this.setDirty(false); }
	public async saveAs(_resource: URI, _signal: AbortSignal): Promise<void> { }
	public async revert(_signal: AbortSignal): Promise<void> { this.setDirty(false); }
}

function createTestLabelService(workspace: ConstructorParameters<typeof LabelService>[0], os: OperatingSystem = operatingSystem): LabelService {
	const api = createDisconnectedRendererApi();
	const host = { ...api, hasAppServer: true, appServer: { ...api.appServer, operatingSystem: os } };
	return new LabelService(workspace, new BrowserPathService(host, workspace), host);
}
