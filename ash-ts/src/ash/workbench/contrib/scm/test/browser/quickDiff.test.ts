import assert from 'node:assert/strict';
import { test } from 'mocha';
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
	using model = new TextModel('same\nnew\nlast');
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
