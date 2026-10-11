import type { GitChangeFileComparison } from './types.js';
import type { GitService } from './gitService.js';
import { localize, URI, extUriBiasedIgnorePathCase } from './support.js';
import { repositoryFileUri } from './gitChangeEditorInput.js';
export interface DiffChangeContext {
	readonly git: Pick<GitService, 'status' | 'indexDiff' | 'editIndex'>;
	readonly editors: { request<T>(payload: unknown): Promise<T>; };
	readonly dialogs: { confirm(options: { message: string; primaryButton?: string; }): Promise<{ confirmed: boolean; }>; };
}

interface DiffChangeState {
	readonly originalText: string; readonly modifiedText: string;
	readonly originalFileText: string; readonly modifiedFileText: string;
	readonly originalVersion: number; readonly modifiedVersion: number;
	readonly start: number; readonly end: number; readonly contiguous: boolean;
	readonly edits: readonly { start: number; end: number; text: string; }[];
}
export async function runDiffChange(ctx: DiffChangeContext, raw: unknown, comparison: GitChangeFileComparison, operation: 'index' | 'revert'): Promise<void> {
	if (!raw || typeof raw !== 'object' || !('originalUri' in raw) || !('modifiedUri' in raw) || typeof raw.originalUri !== 'string' || typeof raw.modifiedUri !== 'string') { throw new TypeError(localize('git.diff.invalidContext', 'Open a change toolbar to run this Git action.')); }
	const original = URI.parse(raw.originalUri), modified = URI.parse(raw.modifiedUri);
	const query = new URLSearchParams(modified.query), originalQuery = new URLSearchParams(original.query);
	const repositoryId = query.get('repository');
	const stale = () => new Error(localize('git.reopenComparison', 'Open the current comparison from Source Control before selecting lines.'));
	if (!repositoryId || original.scheme !== 'git-change' || modified.scheme !== 'git-change' || !original.path.startsWith(`/${comparison}/`) || !modified.path.startsWith(`/${comparison}/`) || query.get('side') !== 'modified' || originalQuery.get('side') !== 'original' || originalQuery.get('repository') !== repositoryId || originalQuery.get('stream') !== query.get('stream') || originalQuery.get('revision') !== query.get('revision')) { throw stale(); }
	const capture = () => ctx.editors.request<DiffChangeState | null>({ method: 'diffChange', context: raw });
	const state = await capture();
	if (!state) { throw stale(); }
	const status = await ctx.git.status(repositoryId);
	if (query.get('stream') !== status.streamInstanceId || query.get('revision') !== String(status.revision)) { throw stale(); }
	const path = modified.path.slice(comparison.length + 2).split('/').map(decodeURIComponent).join('/');
	const reviewed = await ctx.git.indexDiff(path, comparison, repositoryId);
	const current = async () => { const next = await capture(); return next && next.originalVersion === state.originalVersion && next.modifiedVersion === state.modifiedVersion && next.originalText === state.originalText && next.modifiedText === state.modifiedText; };
	if ((reviewed.original ?? '') !== state.originalFileText || (reviewed.modified ?? '') !== state.modifiedFileText || !await current()) { throw stale(); }
	if (operation === 'index') {
		if (!state.contiguous) { throw new Error(localize('git.diff.contiguousSelection', 'Select one continuous change block to stage or unstage selected lines.')); }
		await ctx.git.editIndex(path, comparison, reviewed, { kind: 'lines', start: state.start, end: state.end }, repositoryId);
		return;
	}
	const resource = query.get('resource');
	if (!resource || !state.edits.length || !extUriBiasedIgnorePathCase.isEqual(URI.parse(resource), repositoryFileUri(status.workspacePath, path))) { throw new Error(localize('git.diff.noWorktree', 'This change has no editable working tree file.')); }
	const dirty = async () => (await ctx.editors.request<readonly { isDirty: boolean; }[]>({ method: 'dirty', uri: resource })).some(copy => copy.isDirty);
	if (await dirty()) { throw new Error(localize('git.diff.dirtyWorktree', 'Save or revert the open file before reverting this change.')); }
	const file = await ctx.editors.request<{ text: string; revision: string | null; encoding: string; }>({ method: 'readTextFile', uri: resource });
	if (!(await ctx.dialogs.confirm({ message: localize('git.diff.revertConfirm', 'Revert the selected changes in {0}?', path), primaryButton: localize('git.diff.revertButton', 'Revert Changes') })).confirmed) { return; }
	const latest = await ctx.git.indexDiff(path, comparison, repositoryId);
	if (file.text !== state.modifiedText || !file.revision || await dirty() || !await current() || (latest.original ?? '') !== state.originalFileText || (latest.modified ?? '') !== state.modifiedFileText) { throw stale(); }
	let result = state.modifiedText;
	for (const edit of [...state.edits].sort((a, b) => b.start - a.start)) { result = result.slice(0, edit.start) + edit.text + result.slice(edit.end); }
	await ctx.editors.request({ method: 'saveTextFile', uri: resource, text: result, encoding: file.encoding, expectedRevision: file.revision });
	await ctx.git.status(repositoryId);
}
