import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { normalizeLanguageWorkspaceEdit, type LanguageWorkspaceEdit } from "../../../../editor/common/languages.js";
import { type IBulkEditOptions, type IBulkEditPreviewHandler, type IBulkEditResult, type IBulkEditService, ResourceEdit, ResourceFileEdit, ResourceTextEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { type IWorkspaceEditService, type WorkspaceEditResult } from "../../../services/language/common/workspaceEditService.js";

/** Adds Workbench preview policy to the ordered workspace-edit transaction. */
export class BrowserBulkEditService extends Disposable implements IBulkEditService {
	declare readonly _serviceBrand: undefined;
	private previewHandler: IBulkEditPreviewHandler | undefined;

	constructor(private readonly workspaceEdits: IWorkspaceEditService) {
		super();
		if (!workspaceEdits || typeof workspaceEdits.apply !== "function") throw new TypeError("Bulk edit service requires a workspace edit applier");
		this._register(toDisposable(() => { this.previewHandler = undefined; }));
	}

	hasPreviewHandler(): boolean {
		return this.previewHandler !== undefined;
	}

	setPreviewHandler(handler: IBulkEditPreviewHandler): ReturnType<typeof toDisposable> {
		if (typeof handler !== "function") throw new TypeError("Bulk edit preview handler must be a function");
		const previous = this.previewHandler;
		this.previewHandler = handler;
		return toDisposable(() => {
			if (this.previewHandler === handler) this.previewHandler = previous;
		});
	}

	async apply(value: ResourceEdit[] | LanguageWorkspaceEdit, options: IBulkEditOptions = {}): Promise<IBulkEditResult> {
		let edits = Array.isArray(value) ? [...value] : ResourceEdit.convert(normalizeLanguageWorkspaceEdit(value));
		const signal = options.token ?? new AbortController().signal;
		if (options.showPreview === true || (options.showPreview !== false && edits.length > 1 && this.previewHandler)) {
			const previewHandler = this.previewHandler;
			if (!previewHandler) throw new Error("Bulk edit preview is not available");
			edits = await previewHandler(edits, options);
			if (signal.aborted || edits.length === 0) return { ariaSummary: 'No edits were applied', isApplied: false };
		}
		const edit = toLanguageWorkspaceEdit(edits);
		const result: WorkspaceEditResult = await this.workspaceEdits.apply(edit, signal);
		return { ariaSummary: `${result.resources.length} resources changed`, isApplied: edit.entries.length > 0 };
	}
}

export function toLanguageWorkspaceEdit(edits: readonly ResourceEdit[]): LanguageWorkspaceEdit {
	return normalizeLanguageWorkspaceEdit({ entries: edits.map(edit => {
		if (edit instanceof ResourceTextEdit) return { kind: 'textDocument', resource: edit.resource, ...(edit.versionId === undefined ? {} : { version: edit.versionId }), edits: [edit.textEdit] };
		if (!(edit instanceof ResourceFileEdit)) throw new TypeError('Unknown resource edit');
		if (edit.oldResource && edit.newResource) return { kind: 'rename', source: edit.oldResource, target: edit.newResource, existing: existing(edit.options) };
		if (edit.newResource) return { kind: 'create', resource: edit.newResource, existing: existing(edit.options) };
		return { kind: 'delete', resource: edit.oldResource!, missing: edit.options.ignoreIfNotExists ? 'ignore' : 'error', mode: edit.options.recursive ? 'recursive' : 'fileOrEmptyDirectory' };
	}) });
}

function existing(options: ResourceFileEdit['options']): 'error' | 'overwrite' | 'ignore' {
	return options.ignoreIfExists ? 'ignore' : options.overwrite ? 'overwrite' : 'error';
}
