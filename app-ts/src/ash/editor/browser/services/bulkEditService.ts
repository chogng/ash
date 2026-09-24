import { type IDisposable } from '../../../base/common/lifecycle.js';
import { type URI } from '../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../platform/instantiation/common/instantiation.js';
import { type TextEdit, normalizeLanguageWorkspaceEdit, type LanguageWorkspaceEdit, type LanguageWorkspaceEditEntry } from '../../common/languages.js';
import { type ICodeEditor } from '../editorBrowser.js';

export const IBulkEditService = createServiceIdentifier<IBulkEditService>('bulkEditService');

export interface WorkspaceEditMetadata {
	readonly label?: string;
}

export interface WorkspaceFileEditOptions {
	readonly overwrite?: boolean;
	readonly ignoreIfExists?: boolean;
	readonly ignoreIfNotExists?: boolean;
	readonly recursive?: boolean;
}

interface ResourceTextEditLike {
	readonly resource: URI;
	readonly textEdit: TextEdit;
	readonly versionId?: number;
	readonly metadata?: WorkspaceEditMetadata;
}

interface ResourceFileEditLike {
	readonly oldResource?: URI;
	readonly newResource?: URI;
	readonly options?: WorkspaceFileEditOptions;
	readonly metadata?: WorkspaceEditMetadata;
}

export abstract class ResourceEdit {
	protected constructor(readonly metadata?: WorkspaceEditMetadata) {}

	static convert(edit: LanguageWorkspaceEdit): ResourceEdit[] {
		return normalizeLanguageWorkspaceEdit(edit).entries.flatMap(entry => resourceEdits(entry));
	}
}

export class ResourceTextEdit extends ResourceEdit {
	static is(candidate: unknown): candidate is ResourceTextEdit {
		const value = candidate as Partial<ResourceTextEdit> | undefined;
		return candidate instanceof ResourceTextEdit || Boolean(value?.resource && value.textEdit);
	}

	static lift(edit: ResourceTextEdit | ResourceTextEditLike): ResourceTextEdit {
		return edit instanceof ResourceTextEdit
			? edit
			: new ResourceTextEdit(edit.resource, edit.textEdit, edit.versionId, edit.metadata);
	}

	constructor(
		readonly resource: URI,
		readonly textEdit: TextEdit,
		readonly versionId: number | undefined = undefined,
		metadata?: WorkspaceEditMetadata,
	) {
		super(metadata);
	}
}

export class ResourceFileEdit extends ResourceEdit {
	static is(candidate: unknown): candidate is ResourceFileEdit {
		const value = candidate as Partial<ResourceFileEdit> | undefined;
		return candidate instanceof ResourceFileEdit || Boolean(value?.oldResource || value?.newResource);
	}

	static lift(edit: ResourceFileEdit | ResourceFileEditLike): ResourceFileEdit {
		return edit instanceof ResourceFileEdit
			? edit
			: new ResourceFileEdit(edit.oldResource, edit.newResource, edit.options ?? {}, edit.metadata);
	}

	constructor(
		readonly oldResource: URI | undefined,
		readonly newResource: URI | undefined,
		readonly options: WorkspaceFileEditOptions = {},
		metadata?: WorkspaceEditMetadata,
	) {
		super(metadata);
		if (!oldResource && !newResource) throw new TypeError('File edit requires a source or target resource');
	}
}

export interface IBulkEditOptions {
	readonly editor?: ICodeEditor;
	readonly progress?: { report(value: unknown): void };
	readonly token?: AbortSignal;
	readonly showPreview?: boolean;
	readonly label?: string;
	readonly code?: string;
	readonly quotableLabel?: string;
	readonly undoRedoSource?: unknown;
	readonly undoRedoGroupId?: number;
	readonly confirmBeforeUndo?: boolean;
	readonly respectAutoSaveConfig?: boolean;
	readonly reason?: unknown;
}

export interface IBulkEditResult {
	readonly ariaSummary: string;
	readonly isApplied: boolean;
}

export type IBulkEditPreviewHandler = (edits: ResourceEdit[], options?: IBulkEditOptions) => Promise<ResourceEdit[]>;

export interface IBulkEditService {
	readonly _serviceBrand: undefined;
	hasPreviewHandler(): boolean;
	setPreviewHandler(handler: IBulkEditPreviewHandler): IDisposable;
	apply(edit: ResourceEdit[] | LanguageWorkspaceEdit, options?: IBulkEditOptions): Promise<IBulkEditResult>;
}

function resourceEdits(entry: LanguageWorkspaceEditEntry): ResourceEdit[] {
	switch (entry.kind) {
		case 'textDocument':
			return entry.edits.map(edit => new ResourceTextEdit(entry.resource, edit, entry.version));
		case 'create':
			return [new ResourceFileEdit(undefined, entry.resource, {
				overwrite: entry.existing === 'overwrite',
				ignoreIfExists: entry.existing === 'ignore',
			})];
		case 'rename':
			return [new ResourceFileEdit(entry.source, entry.target, {
				overwrite: entry.existing === 'overwrite',
				ignoreIfExists: entry.existing === 'ignore',
			})];
		case 'delete':
			return [new ResourceFileEdit(entry.resource, undefined, {
				ignoreIfNotExists: entry.missing === 'ignore',
				recursive: entry.mode === 'recursive',
			})];
	}
}
