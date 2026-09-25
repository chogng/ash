import type { IEditorPane } from "./editorPane.js";

/** Pane capability persisted with an editor working set. */
export interface IEditorPaneWithViewState extends IEditorPane {
	readonly viewStateTypeId: string;
	saveViewState(): unknown;
	restoreViewState(state: unknown): void;
}

export function isEditorPaneWithViewState(pane: IEditorPane): pane is IEditorPaneWithViewState {
	const candidate = pane as Partial<IEditorPaneWithViewState>;
	return typeof candidate.viewStateTypeId === "string" && candidate.viewStateTypeId.length > 0 &&
		typeof candidate.saveViewState === "function" && typeof candidate.restoreViewState === "function";
}
