import type { MultiDiffEditorPaneOptions } from '../../browser/multiDiffEditorPane.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { validateJsonValue } from '../../../../../base/common/jsonValue.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
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
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { EditorPaneVisibility } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorPartsService } from '../../../../browser/parts/editor/editorParts.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { TextFileContentSource, type ITextFileService, type ResolvedTextFileContent, type TextFileResolveRequest } from '../../../../services/textfile/common/textFileService.js';
import type { EditorInput, IEditorService } from '../../../../services/editor/common/editorService.js';
import type { GitStatus, IGitService } from '../../../../services/git/common/gitService.js';
import type { IChatService, TurnChangeSetSummary } from '../../../../services/chat/common/chatService.js';
import type { ISessionsManagementService } from '../../../../../sessions/services/sessions/common/sessionsManagementService.js';
import { CodeEditorConfiguration } from '../../../codeEditor/common/editorConfiguration.js';
import { EditorLineWrapping, EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { type ITextModelResourceService, type TextModelInput, type TextModelReference } from '../../../../services/textmodelResolver/common/textModelResourceService.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
browserEnvironment.window.HTMLCanvasElement.prototype.getContext = () => null;
class TestResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
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
const { MultiDiffEditorPane } = await import('../../browser/multiDiffEditorPane.js');
await import('../../../codeEditor/browser/toggleWordWrap.js');
const { createGitMultiDiffEditorInput } = await import('../../browser/scmMultiDiffAction.js');
const { createTurnMultiDiffEditorInput } = await import('../../browser/turnMultiDiffSource.js');

test('Multi-diff sources resolve uncommitted Git and composed Turn contents', async () => {
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

	const summaries: TurnChangeSetSummary[] = [
		{ changeSetId: 'one', sessionId: 'session', threadId: 'thread', turnId: 'turn-one', repositoryId: 'repo', targetBranch: 'main', statistics: { files: 1, additions: 1, deletions: 1 }, captureState: 'sealed', messageState: 'ready', commitState: 'idle', dependencies: [], externalDependencyPaths: [], warnings: [], conflictPaths: [], revision: 1 },
		{ changeSetId: 'two', sessionId: 'session', threadId: 'thread', turnId: 'turn-two', repositoryId: 'repo', targetBranch: 'main', statistics: { files: 1, additions: 1, deletions: 1 }, captureState: 'sealed', messageState: 'ready', commitState: 'idle', dependencies: [], externalDependencyPaths: [], warnings: [], conflictPaths: [], revision: 2 },
	];
	const chat = {
		listTurnChanges: async () => summaries,
		readTurnChange: async (_sessionId: string, _threadId: string, changeSetId: string) => ({ summary: summaries.find(summary => summary.changeSetId === changeSetId)!, files: [{ path: 'src/file.ts', kind: 'modified', binary: false, additions: 1, deletions: 1 }] }),
		readTurnChangeFile: async (_sessionId: string, _threadId: string, changeSetId: string) => changeSetId === 'one'
			? { path: 'src/file.ts', binary: false, truncated: false, before: 'before', after: 'middle' }
			: { path: 'src/file.ts', binary: false, truncated: false, before: 'middle', after: 'after' },
	} as unknown as IChatService;
	const turnInput = await createTurnMultiDiffEditorInput(chat, { session: { sessionId: 'session' }, threadId: 'thread' } as never, 'throughCurrentTurn');
	assert.deepEqual({
		before: turnInput.items[0]?.original.initialText,
		after: turnInput.items[0]?.modified.initialText,
		ids: turnInput.source?.kind === 'turn' ? turnInput.source.changeSetIds : [],
	}, { before: 'before', after: 'after', ids: ['one', 'two'] });
});

test('Stanza multi-diff pane resolves visible comparisons and releases the complete session', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	const resourceStore = new BrowserTextResourceStore(new BootstrapTextFiles());
	using models = new BrowserTextModelService(resourceStore);
	using commands = new CommandService(new ServiceContainer());
	using contexts = new ContextKeyService();
	const menus = new MenuService(commands, contexts);
	const gitActions: string[] = [];
	const opened: string[] = [];
	const contextMenus: string[][] = [];
	const committedChangeSets: string[] = [];
	const changeSet = {
		changeSetId: 'change-1', sessionId: 'session-1', threadId: 'thread-1', turnId: 'turn-1', repositoryId: 'repo', targetBranch: 'main',
		statistics: { files: 1, additions: 1, deletions: 1 }, captureState: 'sealed', messageState: 'ready', commitState: 'idle',
		dependencies: [], externalDependencyPaths: [], warnings: [], conflictPaths: [], revision: 1,
	} satisfies TurnChangeSetSummary;
	Object.defineProperty(dom.window, 'confirm', { configurable: true, value: () => true });
	using editorServices = new DisposableStore();
	const services = createCodeEditorServices(editorServices);
	const configuration = services.get(IConfigurationService);
	await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, false, { overrideIdentifier: 'typescript' });
	const seenOptions: boolean[] = [];
	const seenLimits: number[] = [];
	const pane = services.createInstance(MultiDiffEditorPane, {
		modelService: models,
		createComputationService: () => new PaneTestDiffComputationService(options => {
			seenOptions.push(options.ignoreTrimWhitespace);
			seenLimits.push(options.maxComputationTimeMs);
		}),
		lineHeight: 24,
		showLineNumbers: false,
		chatService: {
			listTurnChanges: async () => [changeSet],
			readTurnChange: async () => ({ summary: changeSet, files: [], draftMessage: 'feat: review changes' }),
			commitTurnChange: async (_sessionId: string, _threadId: string, changeSetId: string) => { committedChangeSets.push(changeSetId); return [{ ...changeSet, commitState: 'committed' }]; },
		} as unknown as IChatService,
		sessionsService: {
			active: { session: { sessionId: 'session-1' }, threadId: 'thread-1' },
		} as unknown as ISessionsManagementService,
		gitService: {
			stage: async (paths: readonly string[]) => { gitActions.push(`stage:${paths.join(',')}`); return {} as never; },
			discardWorktree: async (paths: readonly string[]) => { gitActions.push(`discard:${paths.join(',')}`); return {} as never; },
		} as unknown as IGitService,
		editorService: {
			openEditor: async (input: EditorInput) => { opened.push(input.resource.toString()); },
		} as unknown as IEditorService,
		fileActions: {
			menuService: menus,
			contextMenuProvider: { showContextMenu(options) { contextMenus.push(options.getActions().map(action => action.label)); } },
			contextKeyService: contexts,
		},
	} satisfies MultiDiffEditorPaneOptions);
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
		kind: 'turn', sessionId: 'session-1', threadId: 'thread-1', changeSetIds: ['change-1'], repositoryId: 'repo', targetBranch: 'main', scope: 'currentTurn',
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
	assert.deepEqual(services.get(ICodeEditorService).listCodeEditors().map(editor => editor.getOption(EditorOption.readOnly)), [true, true, true, false]);
	assert.deepEqual(services.get(ICodeEditorService).listCodeEditors().map(editor => editor.getOption(EditorOption.scrollBeyondLastLine)), [false, false, false, false]);
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-file-actions > .ash-toolbar').length, 2);
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-toolbar').length, 1);
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-toolbar .ash-dropdown-with-primary-action-view-item').length, 2);
	assert.equal(parent.querySelectorAll('button button').length, 0);
	requiredElement<HTMLButtonElement>(dom.window.document, '.stanza-multi-diff-editor-source-toolbar .ash-dropdown-with-primary-dropdown button').click();
	requiredElement<HTMLButtonElement>(dom.window.document, '.stanza-multi-diff-editor-repository-toolbar .ash-dropdown-with-primary-dropdown button').click();
	requiredElement<HTMLButtonElement>(dom.window.document, '.stanza-multi-diff-editor-repository-toolbar .ash-toolbar-more-actions button').click();
	assert.deepEqual(contextMenus, [
		['Current Turn', 'Current Turn and Earlier', 'Previous Turn', 'Stage', 'Unstage', 'Uncommitted'],
		['Commit', 'Commit and Push', 'Push'],
		['Collapse All', 'Expand All', 'Stage All', 'Discard All'],
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
	pane.setVisible(EditorPaneVisibility.Hidden);
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
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	using models = new BrowserTextModelService(new BrowserTextResourceStore(new BootstrapTextFiles()));
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
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
				save: signal => reference.save(signal),
				revert: signal => reference.revert(signal),
				dispose,
				[Symbol.dispose]: dispose,
			};
		},
		dispose: () => models.dispose(),
		[Symbol.dispose]: () => models.dispose(),
	};
	using pane = services.createInstance(MultiDiffEditorPane, {
		modelService: trackedModels,
		createComputationService: () => new PaneTestDiffComputationService(),
	} satisfies MultiDiffEditorPaneOptions);
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
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	using models = new BrowserTextModelService(new BrowserTextResourceStore(new BootstrapTextFiles()));
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	const partialModels: ITextModelResourceService = {
		acquire: (input, signal) => input.resource.path.includes('/broken/')
			? Promise.reject(new Error('Unavailable'))
			: models.acquire(input, signal),
		dispose: () => models.dispose(),
		[Symbol.dispose]: () => models.dispose(),
	};
	using pane = services.createInstance(MultiDiffEditorPane, {
		modelService: partialModels,
		createComputationService: () => new PaneTestDiffComputationService(),
	} satisfies MultiDiffEditorPaneOptions);
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
		const dom = new JSDOM('<!doctype html><body><main></main></body>');
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
		using models = new BrowserTextModelService(new BrowserTextResourceStore(new BootstrapTextFiles()));
		using resources = new DisposableStore();
		const services = createCodeEditorServices(resources);
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
		using pane = services.createInstance(MultiDiffEditorPane, {
			modelService: delayedModels,
			createComputationService: () => new PaneTestDiffComputationService(),
		} satisfies MultiDiffEditorPaneOptions);
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

test('Multi-diff pane inherits word wrap and routes the toggle command to its view', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	const resourceStore = new BrowserTextResourceStore(new BootstrapTextFiles());
	using models = new BrowserTextModelService(resourceStore);
	using resources = new DisposableStore();
	const services = createCodeEditorServices(resources);
	const configuration = services.get(IConfigurationService);
	await configuration.updateValue(CodeEditorConfiguration.wordWrap, EditorLineWrapping.On);
	const pane = services.createInstance(MultiDiffEditorPane, {
		modelService: models,
		createComputationService: () => new PaneTestDiffComputationService(),
	} satisfies MultiDiffEditorPaneOptions);
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
	readonly onDidChangeFiles = () => ({ dispose() {}, [Symbol.dispose]() {} });

	async resolve(request: TextFileResolveRequest): Promise<ResolvedTextFileContent> {
		return {
			resource: request.resource,
			text: request.bootstrapText ?? '',
			source: request.bootstrapText === undefined ? TextFileContentSource.FileSystem : TextFileContentSource.Bootstrap,
			revision: undefined,
			encoding: "utf8",
		};
	}

	async save(): Promise<{ readonly revision: string | undefined }> {
		return { revision: undefined };
	}
}

class PaneTestDiffComputationService implements IDocumentDiffProvider {
	readonly onDidChange = Event.None;
	constructor(private readonly observe?: (options: IDocumentDiffProviderOptions) => void) {}

	async computeDiff(original: ITextModel, modified: ITextModel, options: IDocumentDiffProviderOptions, token: CancellationToken): Promise<IDocumentDiff> {
		assert.equal(token.isCancellationRequested, false);
		this.observe?.(options);
		const result = new DefaultLinesDiffComputer().computeDiff(original.getLinesContent(), modified.getLinesContent(), options);
		return { identical: original.getValue() === modified.getValue(), quitEarly: result.hitTimeout, changes: result.changes, moves: result.moves };
	}

	dispose(): void {}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

function requiredElement<T extends Element>(ownerDocument: ParentNode, selector: string): T {
	const element = ownerDocument.querySelector<T>(selector);
	if (!element) throw new Error(`Missing ${selector}`);
	return element;
}
