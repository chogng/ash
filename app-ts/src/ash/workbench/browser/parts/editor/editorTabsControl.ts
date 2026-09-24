import type { TabListDropPosition } from "../../../../base/browser/ui/tablist/tabList.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { EditorInput } from "./editorInput.js";
import { h } from "../../../../base/browser/dom.js";
import type { EditorInstanceId } from "../../../services/editor/common/editorState.js";

/** One open Editor presented by an EditorTabsControl. */
export interface EditorTabDescriptor {
	readonly instanceId: EditorInstanceId;
	readonly input: EditorInput;
	readonly panelId: string;
	readonly tabId: string;
	readonly preview?: boolean;
	readonly isDirty?: boolean;
	readonly hasExternalChange?: boolean;
}

/** Callbacks through which an Editor tab presentation requests group-level mutations. */
export interface EditorTabsDelegate {
	activate(input: EditorInput): void;
	preview(input: EditorInput): void;
	close(input: EditorInput): void;
	startDrag(input: EditorInput): void;
	isDragging(): boolean;
	drop(target: EditorInput | undefined, position: TabListDropPosition): void;
	dropExternal(event: DragEvent, target: EditorInput | undefined, position: TabListDropPosition): void;
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

	abstract setEditors(editors: readonly EditorTabDescriptor[], activeInput: EditorInput | undefined): void;
}

export function editorInputKey(input: EditorInput): string {
	return input.resource.toString();
}
