import type { IResourceEditorInput } from '../../../sdk/browser/index.js';
import { URI } from './support.js';
import type { GitChangeFileComparison, GitChangeStatus, GitCommitFileContent, GitRepositoryChange, GitStatus, IGitService } from './types.js';

export interface ResolvedGitChangeInputs {
	readonly binary?: boolean;
	readonly original: IResourceEditorInput | undefined;
	readonly modified: IResourceEditorInput | undefined;
	readonly goToFile: IResourceEditorInput | undefined;
}

/** Resolves one Git change into the ordinary text-resource inputs used by diff panes. */
export async function resolveGitChangeInputs(gitService: IGitService, status: GitStatus, change: GitRepositoryChange, comparison: GitChangeFileComparison): Promise<ResolvedGitChangeInputs> {
	const file = await gitService.changeFile(change.path, comparison, status.repositoryId);
	const originalPath = changeOriginalPath(change, comparison);
	const [originalState, modifiedState] = comparison === 'staged'
		? ['HEAD', 'Index'] as const
		: ['Index', 'Working Tree'] as const;
	const workingResource = change.worktreeStatus !== 'deleted' && !(change.indexStatus === 'deleted' && change.worktreeStatus === 'unmodified')
		? repositoryFileUri(status.workspacePath, change.path) : undefined;
	const original = changeEditorInput(file.original, changeFileUri(status, comparison, originalPath, 'original', workingResource), `${basename(originalPath)} (${originalState})`);
	const modified = changeEditorInput(file.modified, changeFileUri(status, comparison, change.path, 'modified', workingResource), `${basename(change.path)} (${modifiedState})`);
	return {
		binary: file.original.kind === 'binary' || file.modified.kind === 'binary',
		original,
		modified,
		goToFile: comparisonStatus(change, comparison) === 'deleted'
			? original ?? modified
			: { resource: repositoryFileUri(status.workspacePath, change.path), label: basename(change.path) },
	};
}

function comparisonStatus(change: GitRepositoryChange, comparison: GitChangeFileComparison): GitChangeStatus {
	return comparison === 'staged' ? change.indexStatus : change.worktreeStatus;
}

function changeOriginalPath(change: GitRepositoryChange, comparison: GitChangeFileComparison): string {
	const status = comparison === 'staged' ? change.indexStatus : change.worktreeStatus;
	return status === 'renamed' || status === 'copied' ? change.originalPath ?? change.path : change.path;
}

function changeEditorInput(content: GitCommitFileContent, resource: URI, label: string): IResourceEditorInput | undefined {
	const text = content.kind === 'text' ? content.text : '';
	const hasBom = text.startsWith('\uFEFF');
	return {
		resource,
		label,
		readOnly: true,
		// Git returns the file BOM in its snapshot; the text model restores it from encoding metadata.
		// Strip exactly one BOM so a following U+FEFF remains part of the document.
		...(content.kind === 'binary' ? { contentType: 'application/octet-stream' } : { initialText: hasBom ? text.slice(1) : text, ...(hasBom ? { encoding: 'utf8bom' } : {}) }),
	};
}

function changeFileUri(status: GitStatus, comparison: GitChangeFileComparison, path: string, side: 'original' | 'modified', workingResource: URI | undefined): URI {
	const encodedPath = path.split('/').map(encodeURIComponent).join('/');
	const query = new URLSearchParams({
		side,
		repository: status.repositoryId,
		stream: status.streamInstanceId,
		revision: String(status.revision),
	});
	if (workingResource) {
		query.set('resource', workingResource.toString());
	}
	return URI.parse(`git-change:/${comparison}/${encodedPath}?${query}`);
}

export function repositoryFileUri(workspacePath: string | undefined, path: string): URI {
	const normalizedPath = path.replaceAll('\\', '/').replace(/^\/+/, '');
	const normalizedWorkspace = workspacePath?.replaceAll('\\', '/').replace(/\/+$/, '');
	if (normalizedWorkspace && (normalizedWorkspace.startsWith('/') || /^[A-Za-z]:\//.test(normalizedWorkspace))) {
		return URI.file(`${normalizedWorkspace}/${normalizedPath}`);
	}
	return URI.parse(`file:///${normalizedPath.split('/').map(encodeURIComponent).join('/')}`);
}

function basename(path: string): string {
	return path.replaceAll('\\', '/').split('/').at(-1) ?? path;
}
