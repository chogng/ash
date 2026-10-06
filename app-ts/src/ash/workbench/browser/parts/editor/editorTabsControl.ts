import type { IResourceEditorInput } from '../../../common/editor.js';
import "./media/editortabscontrol.css";
import type { TabListDropPosition } from "../../../../base/browser/ui/tablist/tabList.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { h } from "../../../../base/browser/dom.js";
import type { EditorInstanceId } from "../../../services/editor/common/editorState.js";

/** One open Editor presented by an EditorTabsControl. */
export interface EditorTabDescriptor {
	readonly instanceId: EditorInstanceId;
	readonly input: IResourceEditorInput;
	readonly panelId: string;
	readonly tabId: string;
	readonly preview?: boolean;
	readonly sticky?: boolean;
	readonly isDirty?: boolean;
	readonly hasExternalChange?: boolean;
}

/** Callbacks through which an Editor tab presentation requests group-level mutations. */
export interface EditorTabsDelegate {
	activate(input: IResourceEditorInput): void;
	select?(input: IResourceEditorInput, modifiers: { readonly toggle: boolean; readonly range: boolean; }): boolean;
	preview(input: IResourceEditorInput): void;
	close(input: IResourceEditorInput): void;
	showContextMenu?(input: IResourceEditorInput, event: MouseEvent | KeyboardEvent, tab: HTMLElement): void;
	pinEditor(input: IResourceEditorInput): void;
	unstickEditor(input: IResourceEditorInput): void;
	startDrag(input: IResourceEditorInput): void;
	isDragging(): boolean;
	drop(target: IResourceEditorInput | undefined, position: TabListDropPosition): void;
	dropExternal(event: DragEvent, target: IResourceEditorInput | undefined, position: TabListDropPosition): void;
	endDrag(): void;
}

/** Common lifecycle contract implemented by each Editor tab presentation mode. */
export abstract class EditorTabsControl extends Disposable {
	readonly domNode: HTMLDivElement;

	protected constructor(container: HTMLElement) {
		super();
		this.domNode = h(container.ownerDocument, "div");
		this.domNode.className = "ash-editor-tabs-control";
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
	}

	abstract setEditors(editors: readonly EditorTabDescriptor[], activeInput: IResourceEditorInput | undefined, selectedIds?: ReadonlySet<EditorInstanceId>): void;
}

export function editorInputKey(input: IResourceEditorInput): string {
	return input.editorId ? JSON.stringify([input.resource.toString(), input.editorId]) : input.resource.toString();
}
