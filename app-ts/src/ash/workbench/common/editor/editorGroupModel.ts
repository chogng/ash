import { extUri } from '../../../base/common/resources.js';
import type { EditorInput } from '../../services/editor/common/editorService.js';
import type { EditorInstanceId } from '../../services/editor/common/editorState.js';

export interface IEditorGroupModelEntry {
	readonly input: EditorInput;
	readonly instanceId: EditorInstanceId;
	readonly preview: boolean;
	readonly sticky: boolean;
}

interface EditorEntry {
	input: EditorInput;
	readonly instanceId: EditorInstanceId;
	preview: boolean;
	sticky: boolean;
}

export interface IEditorOpenOptions {
	readonly pinned?: boolean;
	readonly index?: number;
	readonly instanceId?: EditorInstanceId;
}

export interface IEditorOpenResult {
	readonly editor: IEditorGroupModelEntry;
	readonly replaced: IEditorGroupModelEntry | undefined;
}

/** Owns tab order and selection; panes and their resources belong to the group view. */
export class EditorGroupModel {
	private readonly editors: EditorEntry[] = [];
	private readonly selection = new Set<EditorInstanceId>();
	private active: EditorEntry | undefined;
	private selectionAnchor: EditorInstanceId | undefined;
	private locked = false;

	public get entries(): readonly IEditorGroupModelEntry[] {
		return this.editors;
	}

	public get activeEditor(): EditorInput | undefined {
		return this.active?.input;
	}

	public get selectedEditors(): readonly EditorInput[] {
		return this.editors.filter(editor => this.selection.has(editor.instanceId)).map(editor => editor.input);
	}

	public get selectedEditorIds(): ReadonlySet<EditorInstanceId> {
		return this.selection;
	}

	public get isLocked(): boolean {
		return this.locked;
	}

	public get stickyCount(): number {
		return this.editors.filter(editor => editor.sticky).length;
	}

	public setLocked(locked: boolean): void {
		this.locked = locked;
	}

	public getEditors(): readonly EditorInput[] {
		return this.editors.map(editor => editor.input);
	}

	public indexOf(input: EditorInput): number {
		const key = extUri.getComparisonKey(input.resource);
		return this.editors.findIndex(editor => extUri.getComparisonKey(editor.input.resource) === key);
	}

	public findEditor(input: EditorInput): IEditorGroupModelEntry | undefined {
		return this.editors[this.indexOf(input)];
	}

	public isPinned(input: EditorInput): boolean {
		return this.findEditor(input)?.preview === false;
	}

	public isSticky(input: EditorInput): boolean {
		return this.findEditor(input)?.sticky === true;
	}

	public openEditor(input: EditorInput, options: IEditorOpenOptions = {}): IEditorOpenResult {
		const existing = this.editors[this.indexOf(input)];
		const replaced = existing ?? (options.pinned === false ? this.editors.find(editor => editor.preview) : undefined);
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

	public updateEditor(input: EditorInput, options: IEditorOpenOptions): void {
		const editor = this.requireEditor(input);
		editor.input = input;
		if (options.pinned === true) {
			editor.preview = false;
		}
		if (options.index !== undefined) {
			this.moveEditor(input, options.index);
		}
	}

	public pin(input: EditorInput): void {
		this.requireEditor(input).preview = false;
	}

	public stick(input: EditorInput): void {
		const editor = this.requireEditor(input);
		editor.sticky = true;
		editor.preview = false;
		this.moveEditor(input, this.stickyCount - 1);
	}

	public unstick(input: EditorInput): void {
		const editor = this.requireEditor(input);
		editor.sticky = false;
		this.moveEditor(input, this.stickyCount);
	}

	public moveEditor(input: EditorInput, index: number): void {
		const editor = this.requireEditor(input);
		this.editors.splice(this.editors.indexOf(editor), 1);
		const target = Math.min(Math.max(editor.sticky ? 0 : this.stickyCount, index), editor.sticky ? this.stickyCount : this.editors.length);
		this.editors.splice(target, 0, editor);
	}

	public setActive(input: EditorInput): boolean {
		const editor = this.requireEditor(input);
		const changed = this.active !== editor;
		this.active = editor;
		this.selection.clear();
		this.selection.add(editor.instanceId);
		this.selectionAnchor = editor.instanceId;
		return changed;
	}

	public setSelection(input: EditorInput, modifiers: { readonly toggle: boolean; readonly range: boolean }): void {
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

	public closeEditor(input: EditorInput): void {
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

	private requireEditor(input: EditorInput): EditorEntry {
		const editor = this.editors[this.indexOf(input)];
		if (!editor) {
			throw new RangeError(`Editor is not open in this group: ${input.resource}`);
		}
		return editor;
	}
}

let editorInstanceId = 0;

function nextEditorInstanceId(): EditorInstanceId {
	return `editor-instance-${++editorInstanceId}`;
}
