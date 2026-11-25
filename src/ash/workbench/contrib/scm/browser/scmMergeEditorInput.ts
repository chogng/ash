import type { IResourceEditorInput } from '../../../common/editor.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorInputSerializers, requireRecord, requireString } from '../../../services/editor/common/editorInputSerializer.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';

export const SCM_MERGE_EDITOR_ID = 'ash.editor.scmMerge';
const contentType = 'application/vnd.ash.scm-merge';

export interface ScmMergeEditorInput extends IResourceEditorInput {
	readonly contentType: typeof contentType;
	readonly repositoryId: string;
	readonly path: string;
	readonly resultResource: URI;
}

export function createScmMergeEditorInput(repositoryId: string, path: string, resultResource: URI, resource?: string): ScmMergeEditorInput {
	return {
		// Build the Git editor identity from the repository and logical path. Both
		// entry points then share a tab, even for names containing URI delimiters.
		resource: resource === undefined || resource.startsWith('git-merge:') ? URI.from({ scheme: 'git-merge', path: `/${repositoryId}/${path}` }) : URI.parse(resource),
		contentType,
		repositoryId,
		path,
		resultResource,
		label: path.split('/').at(-1) ?? path,
		showBreadcrumbs: false,
	};
}

export function isScmMergeEditorInput(input: IResourceEditorInput): input is ScmMergeEditorInput {
	return input.contentType === contentType && 'repositoryId' in input && typeof input.repositoryId === 'string'
		&& 'path' in input && typeof input.path === 'string'
		&& 'resultResource' in input && input.resultResource instanceof URI;
}

export function matchScmMergeEditor(input: IResourceEditorInput): EditorPaneMatch {
	return isScmMergeEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None;
}

EditorInputSerializers.registerStatic({
	typeId: 'workbench.editorInput.scmMerge',
	canSerialize: isScmMergeEditorInput,
	serialize: input => {
		if (!isScmMergeEditorInput(input)) throw new TypeError('SCM merge input required');
		return { resource: input.resource.toString(), repositoryId: input.repositoryId, path: input.path, resultResource: input.resultResource.toString(), label: input.label };
	},
	deserialize: value => {
		const record = requireRecord(value, 'SCM merge input');
		const input = createScmMergeEditorInput(
			requireString(record.repositoryId, 'SCM merge repository'),
			requireString(record.path, 'SCM merge path'),
			URI.parse(requireString(record.resultResource, 'SCM merge result resource')),
			requireString(record.resource, 'SCM merge resource'),
		);
		return {
			...input,
			label: requireString(record.label, 'SCM merge label'),
		};
	},
});
