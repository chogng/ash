import { URI, type IResourceEditorInput } from '../../../sdk/browser/index.js';
import type { GitChangeFileComparison, GitRepositoryChange, GitStatus, IGitService } from './types.js';
import { resolveGitChangeInputs } from './gitChangeEditorInput.js';
import { localize } from './support.js';
export const OpenScmMultiDiffEditorCommandId = 'git.openChanges';
export interface OpenScmMultiDiffEditorOptions { title: string; comparison: GitChangeFileComparison; status: GitStatus; changes: readonly GitRepositoryChange[]; }
export type OpenScmMultiDiffEditorResult = 'opened' | 'empty' | 'stale';
type Scope = 'staged' | 'unstaged' | 'uncommitted';
interface Item { binary?: boolean; id: string; label: string; original: IResourceEditorInput; modified: IResourceEditorInput; goToFile?: IResourceEditorInput; actions: readonly { id: string; label: string; tooltip: string; icon: string; command: string; arguments: readonly unknown[]; }[]; }
export interface GitMultiDiffInput extends IResourceEditorInput { kind: 'multiDiff'; items: readonly Item[]; source: { kind: 'external'; providerId: string; label: string; repositoryId: string; branchName?: string; }; }
export async function createGitMultiDiffEditorInput(git: IGitService, scope: Scope, knownStatus?: GitStatus, title?: string, knownChanges?: readonly GitRepositoryChange[]): Promise<GitMultiDiffInput> {
	const status = knownStatus ?? await git.status();
	const items: Item[] = [];
	const label = title ?? (scope === 'staged' ? localize('git.stagedChanges', 'Staged Changes') : scope === 'unstaged' ? localize('git.changes', 'Changes') : localize('git.uncommittedChanges', 'Uncommitted Changes'));
	for (const change of knownChanges ?? status.changes) {
		if (change.conflicted || scope === 'staged' && change.indexStatus === 'unmodified' || scope === 'unstaged' && change.worktreeStatus === 'unmodified') { continue; }
		let inputs = await resolveGitChangeInputs(git, status, change, scope === 'staged' ? 'staged' : 'unstaged');
		if (scope === 'uncommitted') { const staged = await resolveGitChangeInputs(git, status, change, 'staged'); inputs = { ...inputs, binary: inputs.binary || staged.binary, original: staged.original ?? inputs.original, modified: inputs.modified ?? staged.modified }; }
		if (!inputs.original || !inputs.modified) { continue; }
		const staged = change.indexStatus !== 'unmodified';
		const actions = [{ id: staged ? 'git.unstageFile' : 'git.stageFile', label: staged ? localize('git.unstageChanges', 'Unstage Changes') : localize('git.stageChanges', 'Stage Changes'), tooltip: staged ? localize('git.unstageChanges', 'Unstage Changes') : localize('git.stageChanges', 'Stage Changes'), icon: staged ? 'remove' : 'check', command: staged ? 'git.unstageFile' : 'git.stageFile', arguments: [status.repositoryId, change.path, scope] }];
		if (change.worktreeStatus !== 'unmodified' && change.worktreeStatus !== 'untracked') { actions.unshift({ id: 'git.discardFile', label: localize('git.discardChanges', 'Discard Changes'), tooltip: localize('git.discardChanges', 'Discard Changes'), icon: 'discard', command: 'git.discardFile', arguments: [status.repositoryId, change.path, scope] }); }
		items.push({ binary: inputs.binary, id: change.path, label: change.originalPath ? `${change.originalPath} → ${change.path}` : change.path, original: inputs.original, modified: inputs.modified, goToFile: inputs.goToFile, actions });
	}
	return { kind: 'multiDiff', resource: URI.from({ scheme: 'ash-scm', authority: 'ash.git', path: `/${encodeURIComponent(status.repositoryId)}`, query: new URLSearchParams({ scope }).toString() }), label, readOnly: true, items, source: { kind: 'external', providerId: 'ash.git', repositoryId: status.repositoryId, label, branchName: status.head.type === 'detached' ? undefined : status.head.name } };
}
