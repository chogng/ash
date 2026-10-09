import type { IResourceEditorInput } from '../editor.js';
import { extUri, type IExtUri } from '../../../base/common/resources.js';
import { EditorInput } from './editorInput.js';

import type { EditorGroupId, EditorInstanceId } from '../../services/editor/common/editorState.js';

export interface IEditorGroupModelEntry {
	readonly input: IResourceEditorInput;
	readonly instanceId: EditorInstanceId;
	readonly preview: boolean;
	readonly sticky: boolean;
}

interface EditorEntry {
	input: IResourceEditorInput;
	readonly instanceId: EditorInstanceId;
	preview: boolean;
	sticky: boolean;
}

export interface IEditorOpenOptions {
	readonly pinned?: boolean;
	readonly index?: number;
	/** Moving a tab keeps its identity across groups; newly opened tabs allocate their own. */
	readonly instanceId?: EditorInstanceId;
}

export interface IEditorOpenResult {
	readonly editor: IEditorGroupModelEntry;
	readonly replaced: IEditorGroupModelEntry | undefined;
}

/** Owns tab order and selection; panes and their resources belong to the group view. */
export class EditorGroupModel {
	public readonly id: EditorGroupId;
	private readonly editors: EditorEntry[] = [];
	private readonly selection = new Set<EditorInstanceId>();
	private active: EditorEntry | undefined;
	private selectionAnchor: EditorInstanceId | undefined;
	private locked = false;

	constructor(id?: EditorGroupId, public readonly editorLimit?: 1, private readonly resourceIdentity: IExtUri = extUri) {
		this.id = id ?? `editor-group-${++editorGroupId}`;
		const match = /^editor-group-(\d+)$/u.exec(this.id);
		if (match) {
			const value = Number(match[1]);
			if (Number.isSafeInteger(value)) {
				editorGroupId = Math.max(editorGroupId, value);
			}
		}
	}

	public get entries(): readonly IEditorGroupModelEntry[] {
		return this.editors;
	}

	public get activeEditor(): IResourceEditorInput | undefined {
		return this.active?.input;
	}

	public get previewEditor(): IResourceEditorInput | undefined {
		return this.editors.find(editor => editor.preview)?.input;
	}

	public get selectedEditors(): readonly IResourceEditorInput[] {
		return this.editors.filter(editor => this.selection.has(editor.instanceId)).map(editor => editor.input);
	}

	public get selectedEditorIds(): ReadonlySet<EditorInstanceId> {
		return this.selection;
	}

	public get isLocked(): boolean {
		return this.locked;
	}

	private get stickyCount(): number {
		return this.editors.filter(editor => editor.sticky).length;
	}

	public setLocked(locked: boolean): void {
		this.locked = locked;
	}

	public getEditors(): readonly IResourceEditorInput[] {
		return this.editors.map(editor => editor.input);
	}

	public indexOf(input: IResourceEditorInput): number {
		const key = this.resourceIdentity.getComparisonKey(input.resource);
		return this.editors.findIndex(editor => {
			if (editor.input instanceof EditorInput) {
				return editor.input.matches(input, this.resourceIdentity);
			}
			if (input instanceof EditorInput) {
				return input.matches(editor.input, this.resourceIdentity);
			}
			return editor.input.editorId === input.editorId && this.resourceIdentity.getComparisonKey(editor.input.resource) === key;
		});
	}

	public findEditor(input: IResourceEditorInput): IEditorGroupModelEntry | undefined {
		return this.editors[this.indexOf(input)];
	}

	public isPinned(input: IResourceEditorInput): boolean {
		return this.findEditor(input)?.preview === false;
	}

	public isSticky(input: IResourceEditorInput): boolean {
		return this.findEditor(input)?.sticky === true;
	}

	public openEditor(input: IResourceEditorInput, options: IEditorOpenOptions = {}): IEditorOpenResult {
		const existing = this.editors[this.indexOf(input)];
		const replaced = existing ?? (this.editorLimit === 1 ? this.editors[0] : options.pinned === false ? this.editors.find(editor => editor.preview) : undefined);
		const editor: EditorEntry = {
			input,
			instanceId: existing?.instanceId ?? options.instanceId ?? nextEditorInstanceId(),
			preview: options.pinned === false && !existing?.sticky,
			sticky: existing?.sticky ?? false,
		};
		if (replaced) {
			this.editors[this.editors.indexOf(replaced)] = editor;
			this.selection.delete(replaced.instanceId);
			if (this.active === replaced) {
				this.active = undefined;
			}
		} else {
			const index = options.index === undefined ? this.editors.length : Math.min(Math.max(this.stickyCount, options.index), this.editors.length);
			this.editors.splice(index, 0, editor);
		}
		return { editor, replaced };
	}

	public updateEditor(input: IResourceEditorInput, options: IEditorOpenOptions): void {
		const editor = this.requireEditor(input);
		editor.input = input;
		if (options.pinned === true) {
			editor.preview = false;
		}
		if (options.index !== undefined) {
			this.moveEditor(input, options.index);
		}
	}

	public pin(input: IResourceEditorInput): void {
		this.requireEditor(input).preview = false;
	}

	public stick(input: IResourceEditorInput): void {
		const editor = this.requireEditor(input);
		editor.sticky = true;
		editor.preview = false;
		this.moveEditor(input, this.stickyCount - 1);
	}

	public unstick(input: IResourceEditorInput): void {
		const editor = this.requireEditor(input);
		editor.sticky = false;
		this.moveEditor(input, this.stickyCount);
	}

	public moveEditor(input: IResourceEditorInput, index: number): void {
		const editor = this.requireEditor(input);
		this.editors.splice(this.editors.indexOf(editor), 1);
		const target = Math.min(Math.max(editor.sticky ? 0 : this.stickyCount, index), editor.sticky ? this.stickyCount : this.editors.length);
		this.editors.splice(target, 0, editor);
	}

	public setActive(input: IResourceEditorInput): boolean {
		const editor = this.requireEditor(input);
		const changed = this.active !== editor;
		this.active = editor;
		this.selection.clear();
		this.selection.add(editor.instanceId);
		this.selectionAnchor = editor.instanceId;
		return changed;
	}

	public setSelection(input: IResourceEditorInput, modifiers: { readonly toggle: boolean; readonly range: boolean; }): void {
		const editor = this.requireEditor(input);
		if (modifiers.range) {
			const anchor = this.editors.findIndex(candidate => candidate.instanceId === this.selectionAnchor);
			const target = this.editors.indexOf(editor);
			const start = anchor < 0 ? target : Math.min(anchor, target);
			const end = anchor < 0 ? target : Math.max(anchor, target);
			if (!modifiers.toggle) {
				this.selection.clear();
			}
			for (let index = start; index <= end; index++) {
				this.selection.add(this.editors[index]!.instanceId);
			}
			return;
		}
		if (this.selection.has(editor.instanceId) && this.selection.size > 1) {
			this.selection.delete(editor.instanceId);
		} else {
			this.selection.add(editor.instanceId);
		}
		this.selectionAnchor = editor.instanceId;
	}

	public closeEditor(input: IResourceEditorInput): void {
		const editor = this.requireEditor(input);
		this.editors.splice(this.editors.indexOf(editor), 1);
		this.selection.delete(editor.instanceId);
		if (this.active === editor) {
			this.active = undefined;
		}
		if (this.selectionAnchor === editor.instanceId) {
			this.selectionAnchor = this.active?.instanceId;
		}
		if (this.selection.size === 0 && this.active) {
			this.selection.add(this.active.instanceId);
			this.selectionAnchor = this.active.instanceId;
		}
	}

	private requireEditor(input: IResourceEditorInput): EditorEntry {
		const editor = this.editors[this.indexOf(input)];
		if (!editor) {
			throw new RangeError(`Editor is not open in this group: ${input.resource}`);
		}
		return editor;
	}
}

let editorGroupId = 0;
let editorInstanceId = 0;

function nextEditorInstanceId(): EditorInstanceId {
	return `editor-instance-${++editorInstanceId}`;
}
