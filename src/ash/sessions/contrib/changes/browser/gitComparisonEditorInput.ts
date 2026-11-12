import { hash } from '../../../../base/common/hash.js';
import { URI } from '../../../../base/common/uri.js';
import type { GitComparisonFile } from '../../../../platform/git/common/localGitService.js';
import { createMultiDiffEditorInput, type MultiDiffEditorInput } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';

/** Presents a Git snapshot with file links resolved against its authorized checkout. */
export function createGitComparisonEditorInput(source: URI, root: URI, files: readonly GitComparisonFile[], label: string): MultiDiffEditorInput {
	const items = files.map(file => {
		const originalPath = file.originalPath ?? file.path;
		const modifiedResource = URI.joinPath(root, file.path);
		// Two groups can compare the same worktree before and after an external edit.
		const revision = hash([file.original, file.modified]);
		return {
			id: file.path,
			label: file.originalPath ? `${file.originalPath} → ${file.path}` : file.path,
			fileList: { path: file.path, originalPath: file.originalPath ?? undefined },
			binary: file.original.kind === 'binary' || file.modified.kind === 'binary',
			contextKeys: { 'sessions.changesGitFile': true },
			original: {
				resource: URI.joinPath(source, originalPath).with({ query: `side=before&revision=${revision}` }),
				preferredResource: URI.joinPath(root, originalPath), readOnly: true, initialText: file.original.kind === 'text' ? file.original.text : ''
			},
			modified: {
				resource: URI.joinPath(source, file.path).with({ query: `side=after&revision=${revision}` }),
				preferredResource: modifiedResource, readOnly: true, initialText: file.modified.kind === 'text' ? file.modified.text : ''
			},
			goToFile: file.modified.kind === 'missing' ? undefined : { resource: modifiedResource },
		};
	});
	return createMultiDiffEditorInput(source, items, label);
}
