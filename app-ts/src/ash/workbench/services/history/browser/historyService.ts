import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import type { EditorPartChangeEvent } from '../../editor/common/editorState.js';
import type { IHistoryService } from '../common/history.js';

/** Owns editor navigation history and its command availability. */
export class HistoryService extends Disposable implements IHistoryService {
	private readonly entries: string[] = [];
	private readonly canNavigateBack: IContextKey<boolean>;
	private readonly canNavigateForward: IContextKey<boolean>;
	private index = -1;
	private isNavigating = false;

	constructor(
		@IEditorPart private readonly editorPart: IEditorPart,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.canNavigateBack = contextKeyService.createKey('canNavigateBack', false);
		this.canNavigateForward = contextKeyService.createKey('canNavigateForward', false);
		this._register(toDisposable(() => {
			this.canNavigateBack.reset();
			this.canNavigateForward.reset();
		}));
		this._register(editorPart.onDidChangeEditors(event => this.onEditorsChanged(event)));
		this.recordActiveEditor();
	}

	public async goBack(): Promise<void> {
		this.navigate(-1);
	}

	public async goForward(): Promise<void> {
		this.navigate(1);
	}

	private onEditorsChanged(event: EditorPartChangeEvent): void {
		if (event.kind === 'groupRemoved' || event.kind === 'groupChanged' && event.event.kind === 'editorClosed') {
			this.pruneClosedEditors();
		}
		if (event.kind === 'activeGroupChanged' || event.kind === 'groupChanged' && event.event.kind === 'activeEditorChanged') {
			this.recordActiveEditor();
		}
		this.updateContextKeys();
	}

	private recordActiveEditor(): void {
		if (this.isNavigating) return;
		const id = this.editorPart.getEditorState().activeEditor?.instanceId;
		if (!id || this.entries[this.index] === id) return;
		this.entries.splice(this.index + 1);
		this.entries.push(id);
		this.index = this.entries.length - 1;
		this.updateContextKeys();
	}

	private navigate(direction: -1 | 1): void {
		this.pruneClosedEditors();
		const nextIndex = this.index + direction;
		if (nextIndex < 0 || nextIndex >= this.entries.length) return;
		const id = this.entries[nextIndex]!;
		const target = this.editorPart.groups.flatMap(group => group.editors).find(editor => editor.instanceId === id);
		if (!target) return;
		this.index = nextIndex;
		this.isNavigating = true;
		try {
			this.editorPart.activateEditorIdentifier(target)?.focus();
		} finally {
			this.isNavigating = false;
			this.updateContextKeys();
		}
	}

	private pruneClosedEditors(): void {
		const openIds = new Set(this.editorPart.groups.flatMap(group => group.editors.map(editor => editor.instanceId)));
		for (let entryIndex = this.entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
			if (openIds.has(this.entries[entryIndex]!)) continue;
			this.entries.splice(entryIndex, 1);
			if (entryIndex <= this.index) this.index -= 1;
		}
	}

	private updateContextKeys(): void {
		this.canNavigateBack.set(this.index > 0);
		this.canNavigateForward.set(this.index >= 0 && this.index < this.entries.length - 1);
	}
}
