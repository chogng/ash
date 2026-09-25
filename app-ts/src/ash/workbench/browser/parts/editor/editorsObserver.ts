import { Disposable } from "../../../../base/common/lifecycle.js";
import type {
	EditorIdentifier,
	EditorInstanceId,
	EditorPartChangeEvent,
	IEditorStateSource,
} from "../../../services/editor/common/editorState.js";

/** Tracks activation order across the editor groups of one editor part. */
export class EditorsObserver extends Disposable {
	private readonly recentIds: EditorInstanceId[] = [];

	constructor(private readonly source: IEditorStateSource) {
		super();
		this._register(source.onDidChangeEditors(event => this.onEditorChange(event)));
	}

	get editors(): readonly EditorIdentifier[] {
		const editorsById = new Map(
			this.source.getEditorState().groups.flatMap(group => group.editors)
				.map(editor => [editor.instanceId, editor]),
		);
		return Object.freeze(this.recentIds.flatMap(id => {
			const editor = editorsById.get(id);
			return editor ? [Object.freeze({
				groupId: editor.groupId,
				instanceId: editor.instanceId,
				paneId: editor.paneId,
				input: editor.input,
			})] : [];
		}));
	}

	private onEditorChange(event: EditorPartChangeEvent): void {
		if (event.kind === "groupChanged") {
			if (event.event.kind === "activeEditorChanged" && event.event.editor) {
				this.touch(event.event.editor.instanceId);
			} else if (event.event.kind === "editorClosed") {
				this.pruneClosedEditors();
			}
		} else if (event.kind === "activeGroupChanged") {
			const group = this.source.getEditorState().groups.find(candidate => candidate.id === event.groupId);
			if (group?.activeEditorInstanceId) this.touch(group.activeEditorInstanceId);
		} else if (event.kind === "groupRemoved") {
			this.pruneClosedEditors();
		}
	}

	private touch(id: EditorInstanceId): void {
		const index = this.recentIds.indexOf(id);
		if (index >= 0) this.recentIds.splice(index, 1);
		this.recentIds.unshift(id);
	}

	private pruneClosedEditors(): void {
		const openIds = new Set(this.source.getEditorState().groups.flatMap(group => group.editors.map(editor => editor.instanceId)));
		for (let index = this.recentIds.length - 1; index >= 0; index -= 1) {
			if (!openIds.has(this.recentIds[index]!)) this.recentIds.splice(index, 1);
		}
	}
}
