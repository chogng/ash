import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { AbstractCodeEditorService } from '../../../../../editor/browser/services/abstractCodeEditorService.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IQuickDiffEditorControllerService, IQuickDiffModelService } from '../../common/quickDiff.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { type IDiffApi } from '../../../../../platform/diff/common/diffApi.js';
import { AppServerDiffService } from '../../../../services/diff/browser/appServerDiffService.js';
import { type GitStatus, type IGitService } from '../../../../services/git/common/gitService.js';
import { GitQuickDiffProvider } from '../../browser/gitQuickDiffProvider.js';
import { QuickDiffDecorator } from '../../browser/quickDiffDecorator.js';
import { QuickDiffModelService } from '../../browser/quickDiffModel.js';
import { WorkbenchQuickDiffService } from '../../browser/workbenchQuickDiffService.js';
import { ScmConfiguration } from '../../common/scmConfiguration.js';

test('Git Quick Diff supplies the index for a live worktree change', async () => {
	const fixture = gitFixture();
	using provider = new GitQuickDiffProvider(fixture.gitService);

	const original = await provider.provideOriginalResource(URI.file('/workspace/src/file.ts'), new AbortController().signal);

	assert.equal(original?.label, 'Index');
	assert.equal(original?.text, 'same\nold\nremoved\nlast');
	assert.deepEqual(fixture.requests, [{ path: 'src/file.ts', comparison: 'unstaged' }]);
	fixture.dispose();
});

test('Quick Diff shares one resource model and projects configurable editor targets', async () => {
	const fixture = gitFixture();
	using provider = new GitQuickDiffProvider(fixture.gitService);
	using quickDiffService = new WorkbenchQuickDiffService();
	using providerRegistration = quickDiffService.addProvider(provider);
	using modelService = new QuickDiffModelService(quickDiffService, new AppServerDiffService(fixture.diffApi));
	using model = new TextModel('same\nnew\nlast', { resource: URI.file('/workspace/src/file.ts') });
	const firstReference = modelService.createModelReference(URI.file('/workspace/src/file.ts'), model);
	const secondReference = modelService.createModelReference(URI.file('/workspace/src/file.ts'), model);
	assert.equal(firstReference.object, secondReference.object);
	firstReference.dispose();
	using configuration = new InMemoryConfigurationService();
	await configuration.updateValue(ScmConfiguration.diffDecorations, 'all');

	using source = new QuickDiffDecorator(model, secondReference, configuration);
	await waitFor(() => model.getAllDecorations().length === 2);
	const decorations = model.getAllDecorations();

	assert.deepEqual(decorations.map(decoration => [decoration.options.linesDecorationsClassName, decoration.range.getStartPosition().lineNumber]), [
		['ash-quick-diff-gutter ash-quick-diff-modified', 2],
		['ash-quick-diff-gutter ash-quick-diff-deleted', 3],
	]);
	assert.ok(decorations.every(decoration => decoration.options.overviewRuler && decoration.options.minimap));
	assert.ok(secondReference.object.findChangeAtLine(2), 'the deletion gutter line resolves to its containing hunk');

	secondReference.dispose();
	fixture.dispose();
});

test('Registered Quick Diff creates after first render and releases decorations on model detach', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const globals = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement })) {
		globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, value });
	}
	try {
		const { CodeEditorWidget } = await import('../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js');
		const { QuickDiffEditorController, QuickDiffEditorControllerService } = await import('../../browser/quickDiffEditorController.js');
		await import('../../browser/quickDiff.contribution.js');
		const fixture = gitFixture();
		using provider = new GitQuickDiffProvider(fixture.gitService);
		using quickDiffService = new WorkbenchQuickDiffService();
		using providerRegistration = quickDiffService.addProvider(provider);
		using modelService = new QuickDiffModelService(quickDiffService, new AppServerDiffService(fixture.diffApi));
		using controllers = new QuickDiffEditorControllerService();
		using configuration = new InMemoryConfigurationService();
		await configuration.updateValue(ScmConfiguration.diffDecorations, 'all');
		using services = new ServiceContainer();
		using codeEditors = new class extends AbstractCodeEditorService { getActiveCodeEditor() { return this.getFocusedCodeEditor(); } }();
		services.registerInstance(ICodeEditorService, codeEditors);
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IQuickDiffModelService, modelService);
		services.registerInstance(IQuickDiffEditorControllerService, controllers);
		using model = new TextModel('same\nnew\nlast', { resource: URI.file('/workspace/src/file.ts') });
		const errors: unknown[] = [];
		using editor = new CodeEditorWidget({
			container: dom.window.document.querySelector('main')!, model,
			input: { resource: URI.file('/workspace/src/file.ts') }, languageId: model.getLanguageId(),
			instantiationService: services, onContributionError: error => errors.push(error),
		});
		assert.deepEqual(fixture.requests, [], 'deferred construction must not fetch during attach');
		await waitFor(() => errors.length > 0 || model.getAllDecorations().some(decoration => decoration.options.linesDecorationsClassName?.includes('ash-quick-diff-gutter')));
		assert.deepEqual(errors, []);
		const controller = editor.getContribution('workbench.contrib.quickDiffEditorController');
		assert.ok(controller instanceof QuickDiffEditorController);
		editor.getDomNode().dispatchEvent(new dom.window.FocusEvent('focusin'));
		assert.equal(controllers.activeController, controller);
		assert.deepEqual(errors, []);
		controller.showNextChange();
		assert.ok(dom.window.document.querySelector('.ash-quick-diff-peek'));
		controller.close();
		assert.equal(dom.window.document.querySelector('.ash-quick-diff-peek'), null);
		editor.setModel(null);
		assert.equal(controller.isDisposed, true);
		assert.equal(controllers.activeController, undefined);
		assert.equal(model.getAllDecorations().length, 0);
		const requestCount = fixture.requests.length;
		editor.setModel(model);
		editor.setModel(null);
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.equal(fixture.requests.length, requestCount, 'detach cancels pending first-render construction');
		assert.deepEqual(errors, []);
		fixture.dispose();
	} finally {
		for (const [name, descriptor] of globals) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
		dom.window.close();
	}
});

function gitFixture(): { readonly gitService: IGitService; readonly diffApi: IDiffApi; readonly requests: Array<{ readonly path: string; readonly comparison: string }>; dispose(): void } {
	const statusChanged = new Emitter<GitStatus>();
	const repositoriesChanged = new Emitter<never>();
	const becameReady = new Emitter<void>();
	const requests: Array<{ readonly path: string; readonly comparison: string }> = [];
	const status: GitStatus = {
		repositoryId: 'repo-1',
		streamInstanceId: 'git-1',
		revision: 7,
		workspacePath: '/workspace',
		head: { type: 'branch', name: 'main', objectId: 'abc', upstream: undefined },
		changes: [{
			path: 'src/file.ts',
			originalPath: undefined,
			indexStatus: 'unmodified',
			worktreeStatus: 'modified',
			conflicted: false,
			submodule: { isSubmodule: false, commitChanged: false, trackedChanges: false, untrackedChanges: false },
		}],
	};
	const gitService = {
		onDidChangeStatus: statusChanged.event,
		onDidChangeRepositoryStatus: statusChanged.event,
		onDidChangeRepositories: repositoriesChanged.event,
		onDidBecomeReady: becameReady.event,
		repositoryForResource: () => ({ id: status.repositoryId, label: 'workspace', path: '', root: URI.file('/workspace') }),
		listRepositories: async () => [],
		status: async () => status,
		changeFile: async (path: string, comparison: string) => {
			requests.push({ path, comparison });
			return {
				original: { kind: 'text' as const, text: 'same\nold\nremoved\nlast' },
				modified: { kind: 'text' as const, text: 'same\nnew\nlast' },
			};
		},
	} as unknown as IGitService;
	const diffApi: IDiffApi = {
		compute: async () => ({
			rows: [
				{ kind: 'context', originalLineIndex: 0, modifiedLineIndex: 0, originalChanges: [], modifiedChanges: [] },
				{ kind: 'modified', originalLineIndex: 1, modifiedLineIndex: 1, originalChanges: [], modifiedChanges: [] },
				{ kind: 'removed', originalLineIndex: 2, modifiedLineIndex: null, originalChanges: [], modifiedChanges: [] },
				{ kind: 'context', originalLineIndex: 3, modifiedLineIndex: 2, originalChanges: [], modifiedChanges: [] },
			],
			hunks: [],
			originalLineCount: 4,
			modifiedLineCount: 3,
		}),
	};
	return {
		gitService,
		diffApi,
		requests,
		dispose(): void {
			statusChanged.dispose();
			repositoriesChanged.dispose();
			becameReady.dispose();
		},
	};
}

async function waitFor(condition: () => boolean, timeoutMillis = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMillis;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for Quick Diff');
		await new Promise(resolve => setTimeout(resolve, 0));
	}
}
