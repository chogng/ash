import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { ILabelService, LabelService } from '../../../../../../platform/label/common/labelService.js';
import { IWorkspaceContextService, type IWorkspace } from '../../../../../../platform/workspace/common/workspace.js';
import { IEditorService, type EditorInput } from '../../../../../services/editor/common/editorService.js';
import { BrowserWorkingCopyService } from '../../../../../services/workingCopy/browser/browserWorkingCopyService.js';
import { IWorkingCopyService, type IWorkingCopy } from '../../../../../services/workingCopy/common/workingCopyService.js';
import { WorkspaceContextService } from '../../../../../services/workspaces/browser/workspaceContextService.js';
import { WindowTitle } from '../../windowTitle.js';

interface TestContext {
	readonly dom: JSDOM;
	readonly services: InstantiationService;
	readonly workspace: WorkspaceContextService;
	readonly workingCopies: BrowserWorkingCopyService;
	readonly labels: LabelService;
	readonly editors: TestEditorService;
}

function createContext(resources: DisposableStore): TestContext {
	const dom = new JSDOM('<!doctype html><title>Previous title</title>');
	resources.add(toDisposable(() => dom.window.close()));
	const services = resources.add(new InstantiationService());
	const workspace = resources.add(new WorkspaceContextService({ id: 'test', folders: [] }));
	const workingCopies = resources.add(new BrowserWorkingCopyService());
	const labels = resources.add(new LabelService(workspace));
	const editors = resources.add(new TestEditorService());
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IWorkingCopyService, workingCopies);
	services.registerInstance(ILabelService, labels);
	services.registerInstance(IEditorService, editors);
	return { dom, services, workspace, workingCopies, labels, editors };
}

test('WindowTitle replaces the startup title and follows workspace changes in each product', () => {
	for (const product of ['Ash Code', 'Embedded Ash']) {
		using resources = new DisposableStore();
		const context = createContext(resources);
		resources.add(context.services.createInstance(WindowTitle, context.dom.window as unknown as Window, product));
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
	resources.add(context.services.createInstance(WindowTitle, context.dom.window as unknown as Window, 'Ash Code'));
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
	const title = resources.add(context.services.createInstance(WindowTitle, context.dom.window as unknown as Window, 'Ash Code'));
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
	scope.registerInstance(IEditorService, popupEditors);
	resources.add(context.services.createInstance(WindowTitle, context.dom.window as unknown as Window, 'Ash Code'));
	const popupTitle = resources.add(scope.createInstance(WindowTitle, popup.window as unknown as Window, 'Ash Code'));
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
	assert.throws(() => services.createInstance(WindowTitle, {} as Window, 'Ash Code'), /Unknown service: editorService/);
});

class TestEditorService extends Disposable implements IEditorService {
	private readonly activeChanged = this._register(new Emitter<void>());
	public readonly onDidActiveEditorChange = this.activeChanged.event;
	public readonly onDidVisibleEditorsChange = Event.None;
	public activeEditor: EditorInput | undefined;
	public get visibleEditors(): readonly EditorInput[] { return this.activeEditor ? [this.activeEditor] : []; }
	public get hasListeners(): boolean { return this.activeChanged.hasListeners(); }
	public async openEditor(input: EditorInput): Promise<void> { this.activeEditor = input; this.activeChanged.fire(); }
	public close(): void { this.activeEditor = undefined; this.activeChanged.fire(); }
	public focusActiveEditor(): void {}
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
	public restoreBackup(): void {}
	public async save(_signal: AbortSignal): Promise<void> { this.setDirty(false); }
	public async saveAs(_resource: URI, _signal: AbortSignal): Promise<void> {}
	public async revert(_signal: AbortSignal): Promise<void> { this.setDirty(false); }
}
