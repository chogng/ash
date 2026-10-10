import { TestUriIdentityServices } from '../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { registerTestComponentServices } from '../../../../test/common/testEditorServices.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import type { IViewsService } from '../../../../services/views/common/viewsService.js';
import type { MultiDiffEditorOptions } from '../../browser/multiDiffEditor.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { validateJsonValue } from '../../../../../base/common/jsonValue.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { setIconResolver } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { getIconDefinition } from '../../../../../platform/theme/common/iconRegistry.js';
import { type CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { type IDocumentDiff, type IDocumentDiffProvider, type IDocumentDiffProviderOptions } from '../../../../../editor/common/diff/documentDiffProvider.js';
import { DefaultLinesDiffComputer } from '../../../../../editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import { type ITextModel } from '../../../../../editor/common/model.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ContextKeyService } from "../../../../../platform/contextkey/browser/contextKeyService.js";
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { DialogResult, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';

import { IEditorPartsService } from '../../../../browser/parts/editor/editorParts.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { TextFileContentSource, type ResolvedTextFileContent, type TextFileResolveRequest } from '../../../../services/textfile/common/textFileService.js';
import { type ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { VIEW_ID } from '../../../files/common/files.js';
import type { IEditorService } from '../../../../services/editor/common/editorService.js';
import type { GitStatus, IGitService } from '../../../../contrib/git/common/gitService.js';
import { IMultiDiffSourceResolverService, MultiDiffSourceResolverService, type IMultiDiffSourceResolver } from '../../browser/multiDiffSourceResolverService.js';
import { CodeEditorConfiguration } from '../../../codeEditor/common/editorConfiguration.js';
import { EditorLineWrapping, EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { type ITextModelResourceService, type TextModelInput, type TextModelReference } from '../../../../services/textmodelResolver/common/textModelResourceService.js';

const uriIdentityServices = new TestUriIdentityServices();
suiteTeardown(() => uriIdentityServices.dispose());

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
browserEnvironment.window.HTMLCanvasElement.prototype.getContext = () => null;
class TestResizeObserver {
	observe(): void { }
	unobserve(): void { }
	disconnect(): void { }
}
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	ResizeObserver: TestResizeObserver,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { createCodeEditorServices } = await import('../../../../../editor/test/browser/testCodeEditor.js');
const { BrowserTextModelService } = await import('../../../../services/textmodelResolver/browser/browserTextModelService.js');
const { BrowserTextResourceStore } = await import('../../../codeEditor/browser/browserTextResourceStore.js');
const { createMultiDiffEditorInput } = await import('../../browser/multiDiffEditorInput.js');
const { MultiDiffEditor } = await import('../../browser/multiDiffEditor.js');
await import('../../../codeEditor/browser/toggleWordWrap.js');
await import('../../../../../editor/browser/widget/diffEditor/commands.js');
await import('../../../../../editor/contrib/diffEditorBreadcrumbs/browser/contribution.js');
const { createGitMultiDiffEditorInput } = await import('../../browser/scmMultiDiffAction.js');

function registerDialogs(services: InstantiationService, sourceResolver?: IMultiDiffSourceResolver): void {
	services.registerInstance(IDialogService, {
		onWillShowDialog: Event.None,
		onDidShowDialog: Event.None,
		about: async () => { throw new Error('Unexpected about dialog'); },
		showMessage: async () => { },
		info: async () => { },
		warn: async () => { },
		error: async () => { },
		confirm: async () => ({ confirmed: true }),
		prompt: async () => { throw new Error('Unexpected prompt'); },
		input: async () => ({ confirmed: false }),
	});
	const resolvers = new MultiDiffSourceResolverService();
	if (sourceResolver) resolvers.registerResolver(sourceResolver);
	services.registerInstance(IMultiDiffSourceResolverService, resolvers);
}

test('Multi-diff source resolves uncommitted Git contents', async () => {
	const status: GitStatus = {
		repositoryId: 'repo', streamInstanceId: 'stream', revision: 3, workspacePath: '/workspace',
		head: { type: 'branch', name: 'main', objectId: 'abc', upstream: undefined },
		changes: [{
			path: 'src/file.ts', originalPath: undefined, indexStatus: 'modified', worktreeStatus: 'modified', conflicted: false,
			submodule: { isSubmodule: false, commitChanged: false, trackedChanges: false, untrackedChanges: false },
		}],
	};
	const git = {
		status: async () => status,
		changeFile: async (_path: string, comparison: 'staged' | 'unstaged') => comparison === 'staged'
			? { original: { kind: 'text', text: 'head' }, modified: { kind: 'text', text: 'index' } }
			: { original: { kind: 'text', text: 'index' }, modified: { kind: 'text', text: 'worktree' } },
	} as unknown as IGitService;
	const gitInput = await createGitMultiDiffEditorInput(git, 'uncommitted');
	assert.deepEqual({
		before: gitInput.items[0]?.original.initialText,
		after: gitInput.items[0]?.modified.initialText,
		readOnly: gitInput.items[0]?.modified.readOnly,
		source: gitInput.source,
	}, {
		before: 'head',
		after: 'worktree',
		readOnly: true,
		source: { kind: 'git', repositoryId: 'repo', scope: 'uncommitted', branchName: 'main' },
	});

});

test('Stanza multi-diff pane resolves visible comparisons and releases the complete session', async () => {
	const dom = createTestDom();
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	const resourceStore = new BrowserTextResourceStore(new BootstrapTextFiles());
	using models = uriIdentityServices.createInstance(BrowserTextModelService, resourceStore, {});
	using commands = new CommandService(new InstantiationService());
	using contexts = new ContextKeyService();
	const menus = new MenuService(commands, contexts);
	const gitActions: string[] = [];
	const opened: string[] = [];
	const focusedViews: string[] = [];
	const contextMenus: string[][] = [];
	const committedChangeSets: string[] = [];
	const externalSourceResolver: IMultiDiffSourceResolver = {
		canHandleUri: uri => uri.path === '/test',
		resolveDiffSource: async () => { throw new Error('Unexpected external multi-diff source'); },
		sourceActions: () => [
			...['Current Turn', 'Current Turn and Earlier', 'Previous Turn'].map((label, index) => ({
				id: `external.${index}`, label, tooltip: label, enabled: true, run: () => { },
			})),
		],
		primaryRepositoryAction: input => input.source?.kind === 'external' ? ({
			id: 'external.commit', label: 'Commit', tooltip: 'Commit', enabled: true,
			run: () => { committedChangeSets.push('change-1'); },
		}) : undefined,
	};
	using editorServices = new DisposableStore();
	const services = createCodeEditorServices(editorServices);
	registerDialogs(services, externalSourceResolver);
	const configuration = services.get(IConfigurationService);
	await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, false, { overrideIdentifier: 'typescript' });
	const seenOptions: boolean[] = [];
	const seenLimits: number[] = [];
	const pane = registerTestComponentServices(services).createInstance(MultiDiffEditor, {
		modelService: models,
		createComputationService: () => new PaneTestDiffComputationService(options => {
			seenOptions.push(options.ignoreTrimWhitespace);
			seenLimits.push(options.maxComputationTimeMs);
		}),
		lineHeight: 24,
		showLineNumbers: false,
		gitService: {
			stage: async (paths: readonly string[]) => { gitActions.push(`stage:${paths.join(',')}`); return {} as never; },
			discardWorktree: async (paths: readonly string[]) => { gitActions.push(`discard:${paths.join(',')}`); return {} as never; },
		} as unknown as IGitService,
		editorService: {
			openEditor: async (input: IResourceEditorInput) => { opened.push(input.resource.toString()); },
		} as unknown as IEditorService,
		viewsService: {
			openView: async () => undefined,
			focusView: async (viewId: string) => { focusedViews.push(viewId); return true; },
			getViewWithId: () => null,
		} as unknown as IViewsService,
		fileActions: {
			menuService: menus,
			contextMenuProvider: { showContextMenu(options) { contextMenus.push(options.getActions().map(action => action.label)); } },
			contextKeyService: contexts,
		},
	} satisfies MultiDiffEditorOptions);
	pane.create(parent);
	pane.layout({ width: 640, height: 480 });
	await pane.setInput(createMultiDiffEditorInput(URI.parse('ash-multi-diff:/test'), [
		{
			label: 'src/first.ts',
			original: { resource: URI.parse('git-change:/first/original'), initialText: 'old', label: 'HEAD' },
			modified: { resource: URI.parse('git-change:/first/modified'), initialText: 'new', languageId: 'typescript', label: 'Working Tree', readOnly: true },
			goToFile: { resource: URI.parse('file:///workspace/src/first.ts') },
			gitChange: { repositoryId: 'repo', path: 'src/first.ts', staged: false, hasWorktreeChanges: true },
		},
		{
			label: 'src/second.ts',
			original: { resource: URI.parse('git-change:/second/original'), initialText: 'before', label: 'HEAD' },
			modified: { resource: URI.parse('git-change:/second/modified'), initialText: 'after', languageId: 'javascript', label: 'Working Tree' },
		},
	], 'Review changes', {
		kind: 'external', providerId: 'sessions.turn', label: 'Current Turn', repositoryId: 'repo', branchName: 'feature/turn-preview',
	}), new AbortController().signal);
	assert.deepEqual(seenOptions, [false, true]);
	await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, false);
	assert.deepEqual(seenOptions, [false, true, false]);
	await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, true, { overrideIdentifier: 'typescript' });
	assert.deepEqual(seenOptions, [false, true, false, true]);
	await configuration.updateValue(CodeEditorConfiguration.diffMaxComputationTime, 25, { overrideIdentifier: 'javascript' });
	assert.deepEqual(seenLimits, [5_000, 5_000, 5_000, 5_000, 25]);

	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-pane').length, 1);
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-session.pending').length, 0);
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-section').length, 2);
	assert.equal(pane.getActiveDiffItem()?.label, 'src/first.ts');
	assert.ok(pane.getControl());
	pane.focus();
	const activeControl = pane.getControl();
	assert.equal(activeControl?.modifiedEditor.getModel()?.getValue(), 'new');
	parent.tabIndex = 0;
	parent.focus();
	assert.equal(pane.getControl(), activeControl);
	pane.focus();
	assert.equal(pane.getControl(), activeControl);
	assert.deepEqual(services.get(ICodeEditorService).listCodeEditors().map(editor => editor.getOption(EditorOption.readOnly)), [true, true, true, false]);
	assert.deepEqual(services.get(ICodeEditorService).listCodeEditors().map(editor => editor.getOption(EditorOption.scrollBeyondLastLine)), [false, false, false, false]);
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-file-actions > .ash-toolbar').length, 2);
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-toolbar').length, 1);
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-toolbar .ash-dropdown-with-primary-action-view-item').length, 1);
	assert.equal(parent.querySelectorAll('button button').length, 0);
	requiredElement<HTMLButtonElement>(dom.window.document, 'button[aria-label="Files"]').click();
	assert.equal(focusedViews.at(-1), VIEW_ID);
	requiredElement<HTMLButtonElement>(dom.window.document, '.stanza-multi-diff-editor-source-toolbar .ash-dropdown-with-primary-dropdown button').click();
	assert.equal(parent.querySelector('.stanza-multi-diff-editor-repository-toolbar .ash-dropdown-with-primary-dropdown'), null);
	requiredElement<HTMLButtonElement>(dom.window.document, '.stanza-multi-diff-editor-repository-toolbar .ash-toolbar-more-actions button').click();
	assert.deepEqual(contextMenus, [
		['Current Turn', 'Current Turn and Earlier', 'Previous Turn', 'Stage', 'Unstage', 'Uncommitted'],
		['Collapse All', 'Expand All'],
	]);
	requiredElement<HTMLButtonElement>(dom.window.document, 'button[aria-label="Commit"]').click();
	assert.equal(parent.querySelector('.stanza-multi-diff-editor')?.getAttribute('aria-label'), 'Review changes, 2 files');
	assert.equal(parent.querySelector('.stanza-multi-diff-editor')?.classList.contains('hide-line-numbers'), true);
	pane.focus();
	assert.equal(requiredElement<HTMLElement>(parent, '.stanza-multi-diff-editor').contains(dom.window.document.activeElement), true);
	assert.equal(pane.viewStateTypeId, 'ash.multiDiffEditor');
	const paneViewState: unknown = validateJsonValue(pane.saveViewState());
	pane.collapseAll();
	pane.restoreViewState(paneViewState);
	assert.ok([...parent.querySelectorAll('.stanza-multi-diff-editor-header-toggle')].every(header => header.getAttribute('aria-expanded') === 'true'));
	requiredElement<HTMLButtonElement>(dom.window.document, 'button[aria-label="Open File"]').click();
	requiredElement<HTMLButtonElement>(dom.window.document, 'button[aria-label="Stage Changes"]').click();
	requiredElement<HTMLButtonElement>(dom.window.document, 'button[aria-label="Discard Changes"]').click();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(opened, ['file:///workspace/src/first.ts']);
	assert.deepEqual(gitActions, ['stage:src/first.ts', 'discard:src/first.ts']);
	assert.deepEqual(committedChangeSets, ['change-1']);
	await pane.setInput(createMultiDiffEditorInput(URI.parse('ash-multi-diff:/history'), [{
		label: 'src/committed.ts',
		original: { resource: URI.parse('git-commit:/parent/committed.ts'), initialText: 'before', readOnly: true },
		modified: { resource: URI.parse('git-commit:/commit/committed.ts'), initialText: 'after', readOnly: true },
	}], 'Committed changes', { kind: 'snapshot', repositoryId: 'repo', label: 'Committed changes' }), new AbortController().signal);
	requiredElement<HTMLButtonElement>(parent, 'button[aria-label="Committed changes"]').click();
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(opened.at(-1), 'ash-multi-diff:/history');
	assert.equal(parent.querySelector('button[aria-label="Commit"]'), null);
	assert.equal(parent.querySelector('button[aria-label="Stage Changes"]'), null);
	assert.equal(parent.querySelector('button[aria-label="Discard Changes"]'), null);
	requiredElement<HTMLButtonElement>(parent, '.stanza-multi-diff-editor-repository-toolbar .ash-toolbar-more-actions button').click();
	assert.deepEqual(contextMenus.at(-1), ['Collapse All', 'Expand All']);
	assert.deepEqual(gitActions, ['stage:src/first.ts', 'discard:src/first.ts']);
	pane.setVisible(false);
	assert.equal((parent.firstElementChild as HTMLElement).hidden, true);
	pane.clearInput();
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor').length, 0);
	assert.equal(services.get(ICodeEditorService).listDiffEditors().length, 0);
	assert.equal(services.get(ICodeEditorService).listCodeEditors().length, 0);
	await pane.setInput(createMultiDiffEditorInput(URI.parse('ash-multi-diff:/empty'), [], 'No changes', {
		kind: 'git', repositoryId: 'repo', scope: 'uncommitted', branchName: 'main',
	}), new AbortController().signal);
	assert.equal(parent.querySelector('.stanza-multi-diff-editor-empty')?.textContent, 'No changes in this selection.');
	pane.clearInput();
	pane.dispose();
	assert.equal(parent.children.length, 0);
	dom.window.close();
});

test('Multi-diff pane acquires text models as files enter the viewport and releases them on clear', async () => {
	const dom = createTestDom();
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	using models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(new BootstrapTextFiles()), {});
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	registerDialogs(services);
	const acquired: string[] = [];
	const released: string[] = [];
	const trackedModels: ITextModelResourceService = {
		async acquire(input: TextModelInput, signal: AbortSignal): Promise<TextModelReference> {
			const reference = await models.acquire(input, signal);
			acquired.push(input.resource.toString());
			let disposed = false;
			const dispose = (): void => {
				if (disposed) return;
				disposed = true;
				released.push(input.resource.toString());
				reference.dispose();
			};
			return {
				resource: reference.resource,
				model: reference.model,
				get isDirty() { return reference.isDirty; },
				onDidChangeDirty: reference.onDidChangeDirty,
				get hasExternalChange() { return reference.hasExternalChange; },
				onDidChangeExternalChange: reference.onDidChangeExternalChange,
				save: (signal, options) => reference.save(signal, options),
				saveAs: (resource, signal) => reference.saveAs(resource, signal),
				revert: signal => reference.revert(signal),
				dispose,
				[Symbol.dispose]: dispose,
			};
		},
		dispose: () => models.dispose(),
		[Symbol.dispose]: () => models.dispose(),
	};
	using pane = registerTestComponentServices(services).createInstance(MultiDiffEditor, {
		modelService: trackedModels,
		createComputationService: () => new PaneTestDiffComputationService(),
	} satisfies MultiDiffEditorOptions);
	pane.create(parent);
	pane.layout({ width: 600, height: 240 });
	const items = Array.from({ length: 100 }, (_, index) => ({
		label: `file-${index}.ts`,
		original: { resource: URI.parse(`git-change:/lazy/${index}/original`), initialText: `old ${index}` },
		modified: { resource: URI.parse(`git-change:/lazy/${index}/modified`), initialText: `new ${index}` },
	}));
	await pane.setInput(createMultiDiffEditorInput(URI.parse('ash-multi-diff:/lazy'), items, 'Lazy files'), new AbortController().signal);
	assert.ok(acquired.length > 0 && acquired.length < 20);
	assert.ok(acquired.every(resource => /\/lazy\/[0-9]\//.test(resource) && Number(resource.match(/\/lazy\/(\d+)\//)?.[1]) < 10));
	const editor = requiredElement<HTMLElement>(parent, '.stanza-multi-diff-editor');
	const content = requiredElement<HTMLElement>(editor, '.stanza-multi-diff-editor-content');
	editor.scrollTop = parseFloat(content.style.height) - 200;
	editor.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
	await new Promise<void>(resolve => {
		const ready = (): boolean => [...editor.querySelectorAll('.stanza-multi-diff-editor-section')].some(section =>
			section.querySelector('.stanza-multi-diff-editor-title')?.textContent === 'file-99.ts'
			&& section.querySelector('.stanza-diff-editor') !== null);
		if (ready()) return resolve();
		const observer = new dom.window.MutationObserver(() => {
			if (!ready()) return;
			observer.disconnect();
			resolve();
		});
		observer.observe(editor, { childList: true, subtree: true });
	});
	assert.ok(acquired.length < 30);
	pane.clearInput();
	assert.deepEqual(released.slice().sort(), acquired.slice().sort());
	dom.window.close();
});

test('Multi-diff pane keeps available files open when one comparison fails to load', async () => {
	const dom = createTestDom();
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	using models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(new BootstrapTextFiles()), {});
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	registerDialogs(services);
	const partialModels: ITextModelResourceService = {
		acquire: (input, signal) => input.resource.path.includes('/broken/')
			? Promise.reject(new Error('Unavailable'))
			: models.acquire(input, signal),
		dispose: () => models.dispose(),
		[Symbol.dispose]: () => models.dispose(),
	};
	using pane = registerTestComponentServices(services).createInstance(MultiDiffEditor, {
		modelService: partialModels,
		createComputationService: () => new PaneTestDiffComputationService(),
	} satisfies MultiDiffEditorOptions);
	pane.create(parent);
	pane.layout({ width: 600, height: 300 });
	await pane.setInput(createMultiDiffEditorInput(URI.parse('ash-multi-diff:/partial'), [
		{
			label: 'available.ts',
			original: { resource: URI.parse('git-change:/available/original'), initialText: 'old' },
			modified: { resource: URI.parse('git-change:/available/modified'), initialText: 'new' },
		},
		{
			label: 'broken.ts',
			original: { resource: URI.parse('git-change:/broken/original'), initialText: 'old' },
			modified: { resource: URI.parse('git-change:/broken/modified'), initialText: 'new' },
		},
	], 'Partial'), new AbortController().signal);
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-session.pending').length, 0);
	assert.equal(parent.querySelectorAll('.stanza-diff-editor').length, 1);
	assert.equal(parent.querySelector('.stanza-multi-diff-editor-incomplete-status:not(:empty)')?.textContent, 'Could not load broken.ts');
	pane.clearInput();
	assert.equal(parent.querySelector('.stanza-multi-diff-editor'), null);
	dom.window.close();
});

for (const cancellation of ['signal', 'clear'] as const) {
	test(`Multi-diff pane releases a model delivered after ${cancellation === 'signal' ? 'input cancellation' : 'clearing pending input'}`, async () => {
		const dom = createTestDom();
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
		using models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(new BootstrapTextFiles()), {});
		using resources = new DisposableStore();
		const services = createCodeEditorServices(resources);
		registerDialogs(services);
		const originalInput = { resource: URI.parse('git-change:/cancel/original'), initialText: 'old' };
		const reference = await models.acquire(originalInput, new AbortController().signal);
		let modelDisposed = false;
		using listener = reference.model.onWillDispose(() => { modelDisposed = true; });
		let signalAcquisitionStarted: (() => void) | undefined;
		const acquisitionStarted = new Promise<void>(resolve => { signalAcquisitionStarted = resolve; });
		let deliver: ((reference: TextModelReference) => void) | undefined;
		const delayedModels: ITextModelResourceService = {
			acquire: async () => {
				signalAcquisitionStarted?.();
				return new Promise<TextModelReference>(resolve => { deliver = resolve; });
			},
			dispose: () => models.dispose(),
			[Symbol.dispose]: () => models.dispose(),
		};
		using pane = registerTestComponentServices(services).createInstance(MultiDiffEditor, {
			modelService: delayedModels,
			createComputationService: () => new PaneTestDiffComputationService(),
		} satisfies MultiDiffEditorOptions);
		pane.create(parent);
		pane.layout({ width: 400, height: 240 });
		const controller = new AbortController();
		const pending = pane.setInput(createMultiDiffEditorInput(URI.parse('ash-multi-diff:/cancel'), [{
			label: 'cancel.ts',
			original: originalInput,
			modified: { resource: URI.parse('git-change:/cancel/modified'), initialText: 'new' },
		}], 'Cancel'), controller.signal);
		await acquisitionStarted;
		assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-session.pending').length, 1);
		if (cancellation === 'signal') controller.abort();
		else pane.clearInput();
		deliver!(reference);
		await assert.rejects(pending, /cancelled/);
		assert.equal(modelDisposed, true);
		assert.equal(parent.querySelector('.stanza-multi-diff-editor'), null);
		dom.window.close();
	});
}

test('Multi-diff collapse command updates mounted and remounted comparisons and preserves the active file', async () => {
	const dom = createTestDom();
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	const resourceStore = new BrowserTextResourceStore(new BootstrapTextFiles());
	using models = uriIdentityServices.createInstance(BrowserTextModelService, resourceStore, {});
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	registerDialogs(services);
	const configuration = services.get(IConfigurationService);
	await configuration.updateValue(CodeEditorConfiguration.diffHideUnchangedRegionsEnabled, true);
	using pane = registerTestComponentServices(services).createInstance(MultiDiffEditor, {
		modelService: models,
		createComputationService: () => new PaneTestDiffComputationService(),
	});
	pane.create(parent);
	pane.layout({ width: 1000, height: 900 });
	const lines = Array.from({ length: 36 }, (_, index) => `shared ${index + 1}`);
	await pane.setInput(createMultiDiffEditorInput(URI.parse('ash-multi-diff:/hidden'), ['first', 'second'].map(name => ({
		label: `${name}.ts`,
		original: { resource: URI.parse(`git-change:/${name}/original`), initialText: lines.join('\n') },
		modified: { resource: URI.parse(`git-change:/${name}/modified`), initialText: [...lines.slice(0, -1), 'changed'].join('\n') },
	})), 'Hidden regions'), new AbortController().signal);
	await pane.nextChange();
	const regions = () => parent.querySelectorAll('.ash-diff-hidden-region');
	assert.equal(regions().length, 4);
	await configuration.updateValue(CodeEditorConfiguration.diffHideUnchangedRegionsMinimumLineCount, 100);
	assert.equal(regions().length, 0);
	await configuration.updateValue(CodeEditorConfiguration.diffHideUnchangedRegionsMinimumLineCount, 3);
	assert.equal(regions().length, 4);
	pane.collapseAll();
	assert.equal(regions().length, 0);
	pane.expandAll();
	assert.equal(regions().length, 4);
	assert.equal(pane.getActiveDiffItem()?.label, 'second.ts');
	pane.collapseAll();
	assert.equal(pane.getActiveDiffItem()?.label, 'second.ts');
	await services.get(ICommandService).executeCommand('diffEditor.toggleCollapseUnchangedRegions');
	pane.expandAll();
	assert.equal(regions().length, 0);
	await services.get(ICommandService).executeCommand('diffEditor.toggleCollapseUnchangedRegions');
	assert.equal(regions().length, 4);
	pane.dispose();
	dom.window.close();
});

test('Multi-diff pane inherits word wrap and routes the toggle command to its view', async () => {
	const dom = createTestDom();
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	const resourceStore = new BrowserTextResourceStore(new BootstrapTextFiles());
	using models = uriIdentityServices.createInstance(BrowserTextModelService, resourceStore, {});
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	registerDialogs(services);

	const configuration = services.get(IConfigurationService);
	await configuration.updateValue(CodeEditorConfiguration.wordWrap, EditorLineWrapping.On);
	const pane = registerTestComponentServices(services).createInstance(MultiDiffEditor, {
		modelService: models,
		createComputationService: () => new PaneTestDiffComputationService(),
	} satisfies MultiDiffEditorOptions);
	pane.create(parent);
	pane.layout({ width: 400, height: 200 });
	await pane.setInput(createMultiDiffEditorInput(URI.parse('ash-multi-diff:/wrap'), [{
		label: 'wrap.ts',
		original: { resource: URI.parse('git-change:/wrap/original'), initialText: 'old ' + 'value '.repeat(40) },
		modified: { resource: URI.parse('git-change:/wrap/modified'), initialText: 'new ' + 'value '.repeat(40) },
	}], 'Wrap'), new AbortController().signal);
	await Promise.resolve();
	const editor = requiredElement<HTMLElement>(dom.window.document, '.stanza-multi-diff-editor');
	assert.equal(editor.classList.contains('word-wrapped'), true);
	services.registerInstance(IEditorPartsService, { activePane: pane } as unknown as IEditorPartsService);
	await services.get(ICommandService).executeCommand('editor.action.toggleWordWrap');
	assert.equal(editor.classList.contains('word-wrapped'), false);
	await configuration.updateValue(CodeEditorConfiguration.diffWordWrap, 'off');
	assert.equal(editor.classList.contains('word-wrapped'), false);
	pane.toggleWordWrap();
	assert.equal(editor.classList.contains('word-wrapped'), false);
	await configuration.updateValue(CodeEditorConfiguration.diffWordWrap, 'on');
	assert.equal(editor.classList.contains('word-wrapped'), true);
	pane.dispose();
	dom.window.close();
});

class BootstrapTextFiles implements ITextFileService {
	readonly onDidSave = Event.None;
	readonly onDidChangeFiles = () => ({ dispose() { }, [Symbol.dispose]() { } });

	async resolve(request: TextFileResolveRequest): Promise<ResolvedTextFileContent> {
		return {
			resource: request.resource,
			text: request.bootstrapText ?? '',
			source: request.bootstrapText === undefined ? TextFileContentSource.FileSystem : TextFileContentSource.Bootstrap,
			revision: undefined,
			encoding: "utf8",
		};
	}

	async save(): Promise<{ readonly revision: string | undefined; }> {
		return { revision: undefined };
	}
}

class PaneTestDiffComputationService implements IDocumentDiffProvider {
	readonly onDidChange = Event.None;
	constructor(private readonly observe?: (options: IDocumentDiffProviderOptions) => void) { }

	async computeDiff(original: ITextModel, modified: ITextModel, options: IDocumentDiffProviderOptions, token: CancellationToken): Promise<IDocumentDiff> {
		assert.equal(token.isCancellationRequested, false);
		this.observe?.(options);
		const result = new DefaultLinesDiffComputer().computeDiff(original.getLinesContent(), modified.getLinesContent(), options);
		return { identical: original.getValue() === modified.getValue(), quitEarly: result.hitTimeout, changes: result.changes, moves: result.moves };
	}

	dispose(): void { }

	[Symbol.dispose](): void {
		this.dispose();
	}
}

function createTestDom(): JSDOM {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	// Workbench themes supply semantic diff icons; a pane-only fixture must bind the same registry.
	setIconResolver(dom.window.document, icon => getIconDefinition(icon));
	return dom;
}

function requiredElement<T extends Element>(ownerDocument: ParentNode, selector: string): T {
	const element = ownerDocument.querySelector<T>(selector);
	if (!element) throw new Error(`Missing ${selector}`);
	return element;
}
