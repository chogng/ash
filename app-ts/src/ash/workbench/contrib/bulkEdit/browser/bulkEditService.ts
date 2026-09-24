import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { normalizeLanguageWorkspaceEdit, type LanguageWorkspaceEdit, type LanguageWorkspaceEditEntry } from "../../../../editor/common/languages.js";
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
		const sourceEdit = Array.isArray(value) ? undefined : normalizeLanguageWorkspaceEdit(value);
		let edits = Array.isArray(value) ? [...value] : ResourceEdit.convert(sourceEdit!);
		const signal = options.token ?? new AbortController().signal;
		let previewed = false;
		if (options.showPreview === true || (options.showPreview !== false && edits.length > 1 && this.previewHandler)) {
			const previewHandler = this.previewHandler;
			if (!previewHandler) throw new Error("Bulk edit preview is not available");
			edits = await previewHandler(edits, options);
			previewed = true;
			if (signal.aborted || edits.length === 0) return { ariaSummary: 'No edits were applied', isApplied: false };
		}
		const edit = sourceEdit && !previewed ? sourceEdit : toLanguageWorkspaceEdit(edits);
		if (edit.entries.length === 0) return { ariaSummary: 'No edits were applied', isApplied: false };
		const result: WorkspaceEditResult = await this.workspaceEdits.apply(edit, signal);
		return { ariaSummary: `${result.resources.length} resources changed`, isApplied: true, undo: result.undo };
	}
}

export function toLanguageWorkspaceEdit(edits: readonly ResourceEdit[]): LanguageWorkspaceEdit {
	const entries: LanguageWorkspaceEditEntry[] = [];
	const groups = new Map<string, { kind: 'textDocument'; resource: ResourceTextEdit['resource']; version?: number; edits: ResourceTextEdit['textEdit'][] }>();
	const flushText = (): void => {
		entries.push(...groups.values());
		groups.clear();
	};
	for (const edit of edits) {
		if (edit instanceof ResourceTextEdit) {
			const key = edit.resource.toString();
			let group = groups.get(key);
			if (!group) {
				group = { kind: 'textDocument', resource: edit.resource, version: edit.versionId, edits: [] };
				groups.set(key, group);
			} else if (edit.versionId !== undefined) {
				if (group.version !== undefined && group.version !== edit.versionId) throw new Error(`Conflicting workspace edit versions for ${key}`);
				group.version = edit.versionId;
			}
			group.edits.push(edit.textEdit);
			continue;
		}
		flushText();
		if (!(edit instanceof ResourceFileEdit)) throw new TypeError('Unknown resource edit');
		if (edit.oldResource && edit.newResource) entries.push({ kind: 'rename', source: edit.oldResource, target: edit.newResource, existing: existing(edit.options) });
		else if (edit.newResource) entries.push({ kind: 'create', resource: edit.newResource, existing: existing(edit.options) });
		else entries.push({ kind: 'delete', resource: edit.oldResource!, missing: edit.options.ignoreIfNotExists ? 'ignore' : 'error', mode: edit.options.recursive ? 'recursive' : 'fileOrEmptyDirectory' });
	}
	flushText();
	return normalizeLanguageWorkspaceEdit({ entries });
}

function existing(options: ResourceFileEdit['options']): 'error' | 'overwrite' | 'ignore' {
	return options.ignoreIfExists ? 'ignore' : options.overwrite ? 'overwrite' : 'error';
}
