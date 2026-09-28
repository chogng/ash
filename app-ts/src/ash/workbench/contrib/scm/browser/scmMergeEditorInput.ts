import { URI } from '../../../../base/common/uri.js';
import type { EditorInput } from '../../../services/editor/common/editorService.js';
import { EditorInputSerializers, requireRecord, requireString } from '../../../services/editor/common/editorInputSerializer.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';

export const SCM_MERGE_EDITOR_ID = 'ash.editor.scmMerge';
const contentType = 'application/vnd.ash.scm-merge';

export interface ScmMergeEditorInput extends EditorInput {
	readonly contentType: typeof contentType;
	readonly repositoryId: string;
	readonly path: string;
	readonly resultResource: URI;
}

export function createScmMergeEditorInput(repositoryId: string, path: string, resource: URI, resultResource: URI): ScmMergeEditorInput {
	return {
		resource,
		contentType,
		repositoryId,
		path,
		resultResource,
		label: path.split('/').at(-1) ?? path,
		showBreadcrumbs: false,
	};
}

export function isScmMergeEditorInput(input: EditorInput): input is ScmMergeEditorInput {
	return input.contentType === contentType && 'repositoryId' in input && typeof input.repositoryId === 'string'
		&& 'path' in input && typeof input.path === 'string'
		&& 'resultResource' in input && input.resultResource instanceof URI;
}

export function matchScmMergeEditor(input: EditorInput): EditorPaneMatch {
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
		return {
			resource: URI.parse(requireString(record.resource, 'SCM merge resource')),
			contentType,
			repositoryId: requireString(record.repositoryId, 'SCM merge repository'),
			path: requireString(record.path, 'SCM merge path'),
			resultResource: URI.parse(requireString(record.resultResource, 'SCM merge result resource')),
			label: requireString(record.label, 'SCM merge label'),
			showBreadcrumbs: false,
		};
	},
});
