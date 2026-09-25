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
	private readonly historyIds: EditorInstanceId[] = [];
	private historyIndex = -1;
	private navigatingHistory = false;
	private navigationTargetId: EditorInstanceId | undefined;

	constructor(private readonly source: IEditorStateSource) {
		super();
		this._register(source.onDidChangeEditors(event => this.onEditorChange(event)));
	}

	get editors(): readonly EditorIdentifier[] {
		const editorsById = this.openEditorsById();
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

	navigateHistory(direction: -1 | 1): EditorIdentifier | undefined {
		const nextIndex = this.historyIndex + direction;
		if (nextIndex < 0 || nextIndex >= this.historyIds.length) return undefined;
		const editor = this.openEditorsById().get(this.historyIds[nextIndex]!);
		if (!editor) {
			this.pruneClosedEditors();
			return this.navigateHistory(direction);
		}
		this.historyIndex = nextIndex;
		this.navigatingHistory = true;
		this.navigationTargetId = editor.instanceId;
		return { groupId: editor.groupId, instanceId: editor.instanceId, paneId: editor.paneId, input: editor.input };
	}

	cancelHistoryNavigation(): void {
		this.navigatingHistory = false;
		this.navigationTargetId = undefined;
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
		if (this.navigatingHistory) {
			if (id === this.navigationTargetId) this.cancelHistoryNavigation();
			return;
		}
		if (this.historyIds[this.historyIndex] === id) return;
		this.historyIds.splice(this.historyIndex + 1);
		this.historyIds.push(id);
		this.historyIndex = this.historyIds.length - 1;
	}

	private pruneClosedEditors(): void {
		const openIds = new Set(this.source.getEditorState().groups.flatMap(group => group.editors.map(editor => editor.instanceId)));
		for (let index = this.recentIds.length - 1; index >= 0; index -= 1) {
			if (!openIds.has(this.recentIds[index]!)) this.recentIds.splice(index, 1);
		}
		for (let index = this.historyIds.length - 1; index >= 0; index -= 1) {
			if (openIds.has(this.historyIds[index]!)) continue;
			this.historyIds.splice(index, 1);
			if (index <= this.historyIndex) this.historyIndex -= 1;
		}
	}

	private openEditorsById() {
		return new Map(this.source.getEditorState().groups.flatMap(group => group.editors)
			.map(editor => [editor.instanceId, editor] as const));
	}
}
