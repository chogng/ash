import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { DOCS_ARKDOWN_EDITOR_ID } from '../common/docs.js';

/** Docs retains its product identity through Save As and working-set restoration. */
export function createArkdownDocsInput(source: IResourceEditorInput): IResourceEditorInput {
	if (source.editorId === DOCS_ARKDOWN_EDITOR_ID && source.rename) return source;
	return {
		...source, editorId: DOCS_ARKDOWN_EDITOR_ID, languageId: 'markdown', contentType: 'text/markdown', showBreadcrumbs: false,
		...(source.resource.scheme === 'untitled' ? { initialText: source.initialText ?? '' } : {}),
		rename: resource => createArkdownDocsInput({ resource }),
	};
}
