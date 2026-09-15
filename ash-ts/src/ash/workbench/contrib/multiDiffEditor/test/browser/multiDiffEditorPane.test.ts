import type { MultiDiffEditorPaneOptions } from '../../browser/multiDiffEditorPane.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { URI } from '../../../../../base/common/uri.js';
import { type DiffComputationRequest, type IDiffComputationService } from '../../../../../editor/common/diff/diffComputationService.js';
import { type LineDiff } from '../../../../../editor/common/diff/lineDiff.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { EditorPaneVisibility } from '../../../../browser/parts/editor/editorPane.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { TextFileContentSource, type ITextFileService, type ResolvedTextFileContent, type TextFileResolveRequest } from '../../../../services/textfile/common/textFileService.js';
import type { EditorInput, IEditorService } from '../../../../services/editor/common/editorService.js';
import type { GitStatus, IGitService } from '../../../../services/git/common/gitService.js';
import type { IChatService, TurnChangeSetSummary } from '../../../../services/chat/common/chatService.js';
import type { ISessionsManagementService } from '../../../../../sessions/services/sessions/common/sessionsManagementService.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { createCodeEditorServices } = await import('../../../../../editor/test/browser/testCodeEditor.js');
const { BrowserTextModelService } = await import('../../../../services/textmodelResolver/browser/browserTextModelService.js');
const { BrowserTextResourceStore } = await import('../../../codeEditor/browser/browserTextResourceStore.js');
const { createMultiDiffEditorInput } = await import('../../browser/multiDiffEditorInput.js');
const { MultiDiffEditorPane } = await import('../../browser/multiDiffEditorPane.js');
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
		source: gitInput.source,
	}, {
		before: 'head',
		after: 'worktree',
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

test('Stanza multi-diff pane resolves every comparison and releases the complete session', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
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
	const pane = createCodeEditorServices(editorServices).createInstance(MultiDiffEditorPane, {
		modelService: models,
		createComputationService: () => new PaneTestDiffComputationService(),
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
			modified: { resource: URI.parse('git-change:/first/modified'), initialText: 'new', label: 'Working Tree' },
			goToFile: { resource: URI.parse('file:///workspace/src/first.ts') },
			gitChange: { repositoryId: 'repo', path: 'src/first.ts', staged: false, hasWorktreeChanges: true },
		},
		{
			label: 'src/second.ts',
			original: { resource: URI.parse('git-change:/second/original'), initialText: 'before', label: 'HEAD' },
			modified: { resource: URI.parse('git-change:/second/modified'), initialText: 'after', label: 'Working Tree' },
		},
	], 'Review changes', {
		kind: 'turn', sessionId: 'session-1', threadId: 'thread-1', changeSetIds: ['change-1'], repositoryId: 'repo', targetBranch: 'main', scope: 'currentTurn',
	}), new AbortController().signal);

	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-pane').length, 1);
	assert.equal(parent.querySelectorAll('.stanza-multi-diff-editor-section').length, 2);
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
	assert.equal(dom.window.document.activeElement?.classList.contains('stanza-multi-diff-editor'), true);
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
	await pane.setInput(createMultiDiffEditorInput(URI.parse('ash-multi-diff:/empty'), [], 'No changes', {
		kind: 'git', repositoryId: 'repo', scope: 'uncommitted', branchName: 'main',
	}), new AbortController().signal);
	assert.equal(parent.querySelector('.stanza-multi-diff-editor-empty')?.textContent, 'No changes in this selection.');
	pane.clearInput();
	pane.dispose();
	assert.equal(parent.children.length, 0);
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

class PaneTestDiffComputationService implements IDiffComputationService {
	async compute(_request: DiffComputationRequest, signal: AbortSignal): Promise<LineDiff> {
		signal.throwIfAborted();
		return Object.freeze({ rows: Object.freeze([]), hunks: Object.freeze([]) });
	}

	dispose(): void {}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

function requiredElement<T extends Element>(ownerDocument: Document, selector: string): T {
	const element = ownerDocument.querySelector<T>(selector);
	if (!element) throw new Error(`Missing ${selector}`);
	return element;
}
