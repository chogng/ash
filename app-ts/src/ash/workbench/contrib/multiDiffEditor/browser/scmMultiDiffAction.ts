import { URI } from '../../../../base/common/uri.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import type { GitChangeFileComparison, GitRepositoryChange, GitStatus } from '../../../services/git/common/gitService.js';
import { IGitService } from '../../../services/git/common/gitService.js';
import { resolveGitChangeInputs } from '../../scm/browser/scmChangeEditorInput.js';
import { createMultiDiffEditorInput, type GitMultiDiffScope, type MultiDiffEditorInput, type MultiDiffEditorInputItem } from './multiDiffEditorInput.js';

export const OpenScmMultiDiffEditorCommandId = '_workbench.openScmMultiDiffEditor';

export interface OpenScmMultiDiffEditorOptions {
	readonly title: string;
	readonly comparison: GitChangeFileComparison;
	readonly status: GitStatus;
	readonly changes: readonly GitRepositoryChange[];
}

export type OpenScmMultiDiffEditorResult = 'opened' | 'empty' | 'stale';

/** Internal SCM command that resolves one resource group into a MultiDiff input. */
export class OpenScmMultiDiffEditorAction extends Action2 {
	constructor() {
		super({
			id: OpenScmMultiDiffEditorCommandId,
			title: 'Open Changes',
			f1: false,
		});
	}

	public override async run(accessor: ServicesAccessor, rawOptions: unknown): Promise<OpenScmMultiDiffEditorResult> {
		const options = validateOptions(rawOptions);
		const gitService = accessor.get(IGitService);
		const currentStatus = await gitService.status();
		if (!isSameStatus(currentStatus, options.status)) return 'stale';
		const input = await createGitMultiDiffEditorInput(gitService, options.comparison, options.status, options.title, options.changes);
		if (input.items.length === 0) return 'empty';
		await accessor.get(IEditorService).openEditor(input, { pinned: true });
		return 'opened';
	}
}

/** Resolves a live Git layer into one actionable multi-diff input. */
export async function createGitMultiDiffEditorInput(gitService: IGitService, scope: GitMultiDiffScope, knownStatus?: GitStatus, title = gitScopeLabel(scope), knownChanges?: readonly GitRepositoryChange[]): Promise<MultiDiffEditorInput> {
	const status = knownStatus ?? await gitService.status();
	const changes = (knownChanges ?? status.changes).filter(change => !change.conflicted && changeMatchesScope(change, scope));
	const items: MultiDiffEditorInputItem[] = [];
	for (const change of changes) {
		const inputs = await resolveScopeInputs(gitService, status, change, scope);
		if (!inputs.original || !inputs.modified) continue;
		items.push({
			label: change.originalPath ? `${change.originalPath} → ${change.path}` : change.path,
			original: inputs.original,
			modified: inputs.modified,
			...(inputs.goToFile ? { goToFile: inputs.goToFile } : {}),
			gitChange: {
				repositoryId: status.repositoryId,
				path: change.path,
				staged: change.indexStatus !== 'unmodified',
				hasWorktreeChanges: change.worktreeStatus !== 'unmodified',
			},
		});
	}
	const source = URI.parse(`ash-multi-diff:/scm/${scope}?repository=${encodeURIComponent(status.repositoryId)}&stream=${encodeURIComponent(status.streamInstanceId)}&revision=${status.revision}`);
	const branchName = status.head.type === 'branch' || status.head.type === 'unborn' ? status.head.name : undefined;
	return createMultiDiffEditorInput(source, items, title, {
		kind: 'git',
		repositoryId: status.repositoryId,
		scope,
		branchName,
	});
}

function changeMatchesScope(change: GitRepositoryChange, scope: GitMultiDiffScope): boolean {
	if (scope === 'staged') return change.indexStatus !== 'unmodified';
	if (scope === 'unstaged') return change.worktreeStatus !== 'unmodified';
	return change.indexStatus !== 'unmodified' || change.worktreeStatus !== 'unmodified';
}

async function resolveScopeInputs(gitService: IGitService, status: GitStatus, change: GitRepositoryChange, scope: GitMultiDiffScope): Promise<Awaited<ReturnType<typeof resolveGitChangeInputs>>> {
	if (scope !== 'uncommitted') return resolveGitChangeInputs(gitService, status, change, scope);
	const [staged, unstaged] = await Promise.all([
		resolveGitChangeInputs(gitService, status, change, 'staged'),
		resolveGitChangeInputs(gitService, status, change, 'unstaged'),
	]);
	return {
		original: staged.original ?? unstaged.original,
		modified: unstaged.modified ?? staged.modified,
		goToFile: unstaged.goToFile ?? staged.goToFile,
	};
}

function gitScopeLabel(scope: GitMultiDiffScope): string {
	if (scope === 'staged') return 'Staged Changes';
	if (scope === 'unstaged') return 'Unstaged Changes';
	return 'Uncommitted Changes';
}

function validateOptions(value: unknown): OpenScmMultiDiffEditorOptions {
	if (!value || typeof value !== 'object') throw new TypeError('Open SCM multi-diff requires options');
	const options = value as Partial<OpenScmMultiDiffEditorOptions>;
	if (typeof options.title !== 'string' || options.title.trim().length === 0) throw new TypeError('Open SCM multi-diff requires a title');
	if (options.comparison !== 'staged' && options.comparison !== 'unstaged') throw new TypeError('Open SCM multi-diff requires a comparison');
	if (!options.status || typeof options.status !== 'object' || !Array.isArray(options.changes)) throw new TypeError('Open SCM multi-diff requires a Git status and changes');
	return options as OpenScmMultiDiffEditorOptions;
}

function isSameStatus(first: GitStatus, second: GitStatus): boolean {
	return first.streamInstanceId === second.streamInstanceId && first.revision === second.revision;
}
