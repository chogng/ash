import type { URI } from '../../../../base/common/uri.js';
import type { IMultiDiffEditorOptions } from '../../../../editor/common/multiDiffEditor.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { EditorOpenTarget } from '../../../../workbench/services/editor/common/editorService.js';
import type { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import type { ISessionChangeset } from '../../../services/sessions/common/session.js';

export interface ISessionChangesEditorOptions extends IMultiDiffEditorOptions {
	readonly changesetSelection?:
	| { readonly kind: 'id'; readonly id: string | undefined; }
	| { readonly kind: 'transient'; readonly changeset: ISessionChangeset; };
}

/** Owns Changes editor identity, opening preferences and reconstructable tab decoration. */
export interface ISessionChangesService {
	getChangesEditorResource(sessionResource: URI): URI;
	getSessionResource(editorResource: URI): URI | undefined;
	openChangesEditor(sessionResource: URI, options?: ISessionChangesEditorOptions, group?: EditorOpenTarget): Promise<IEditorGroup | undefined>;
	resolveChangeset(sessionResource: URI, id: string): Promise<ISessionChangeset>;
	setChangesCount(editorResource: URI, count: number | undefined): void;
}

export const ISessionChangesService = createServiceIdentifier<ISessionChangesService>('sessionChangesService');
