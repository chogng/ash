import './postEditWidget.css';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { type CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { type IContextKey, type RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { type IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { type INotificationService } from '../../../../platform/notification/common/notification.js';
import { ContentWidgetPositionPreference, type ICodeEditor, type IContentWidget, type IContentWidgetPosition } from '../../../browser/editorBrowser.js';
import { type IBulkEditService, ResourceFileEdit, ResourceTextEdit } from '../../../browser/services/bulkEditService.js';
import { Range } from '../../../common/core/range.js';
import { type DocumentDropEdit, type DocumentPasteEdit, type WorkspaceEdit, type WorkspaceEditEntry } from '../../../common/languages.js';
import { TrackedRangeStickiness } from '../../../common/model.js';
import { TextModel } from '../../../common/model/textModel.js';
import { CodeEditorStateFlag, EditorStateCancellationTokenSource } from '../../editorState/browser/editorState.js';
import { SnippetController2 } from '../../snippet/browser/snippetController2.js';
import { createSnippetVariables, parseSnippet, type Snippet } from '../../snippet/common/snippetParser.js';
import { createCombinedWorkspaceEdit } from './edit.js';

type TransferEdit = DocumentDropEdit | DocumentPasteEdit;

export interface EditSet<T extends TransferEdit> {
	readonly activeEditIndex: number;
	readonly allEdits: readonly T[];
}

/** Owns the small editor-local selector shown after a paste or drop with alternatives. */
class PostEditWidget<T extends TransferEdit> extends Disposable implements IContentWidget {
	private readonly select: HTMLSelectElement;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly id: string,
		private readonly range: Range,
		label: string,
		edits: EditSet<T>,
		onSelect: (index: number) => void,
		onDismiss: () => void,
	) {
		super();
		const document = editor.getDomNode()!.ownerDocument;
		this.select = document.createElement('select');
		this.select.className = 'stanza-editor-post-edit-selector';
		this.select.setAttribute('aria-label', label);
		this.select.setAttribute('aria-description', localize('dropOrPaste.selectorHelp', 'Use arrow keys to choose an edit. Press Escape to return to the editor.'));
		this.select.title = label;
		for (const [index, edit] of edits.allEdits.entries()) {
			const option = document.createElement('option');
			option.value = String(index);
			option.textContent = edit.title;
			this.select.add(option);
		}
		this.select.value = String(edits.activeEditIndex);
		this._register(addDisposableListener(this.select, 'change', () => onSelect(Number(this.select.value))));
		this._register(addDisposableListener<KeyboardEvent>(this.select, 'keydown', event => {
			if (event.key !== 'Escape') return;
			event.stopPropagation();
			onDismiss();
			editor.focus();
		}));
		editor.addContentWidget(this);
		this._register(toDisposable(() => editor.removeContentWidget(this)));
		this._register(editor.onDidChangeCursorPosition(onDismiss));
		editor.layoutContentWidget(this);
	}

	getId(): string { return this.id; }
	getDomNode(): HTMLElement { return this.select; }
	getPosition(): IContentWidgetPosition {
		return {
			position: this.range.getEndPosition(),
			preference: [ContentWidgetPositionPreference.BELOW, ContentWidgetPositionPreference.ABOVE],
		};
	}
	showSelector(): void { this.select.focus(); }
}

export class PostEditWidgetManager<T extends TransferEdit> extends Disposable {
	private readonly widget = this._register(new MutableDisposable<PostEditWidget<T>>());
	private readonly visible: IContextKey<boolean>;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly bulkEdits: IBulkEditService,
		private readonly notifications: INotificationService,
		private readonly id: string,
		private readonly label: string,
		visibleContext: RawContextKey<boolean>,
		contextKeys: IContextKeyService,
	) {
		super();
		this.visible = visibleContext.bindTo(contextKeys);
		this.visible.set(false);
		this._register(toDisposable(() => this.visible.reset()));
		this._register(editor.onDidChangeModel(() => this.clear()));
		this._register(editor.onDidChangeModelContent(() => this.clear()));
	}

	clear(): void {
		this.widget.clear();
		this.visible.set(false);
	}
	tryShowSelector(): void { this.widget.value?.showSelector(); }

	async applyEditAndShowIfNeeded(
		ranges: readonly Range[],
		edits: EditSet<T>,
		canShowWidget: boolean,
		resolve: (edit: T, token: CancellationToken) => Promise<T>,
		token: CancellationToken,
	): Promise<void> {
		this.clear();
		const model = this.editor.getModel();
		const candidate = edits.allEdits[edits.activeEditIndex];
		if (!(model instanceof TextModel) || !candidate || ranges.length === 0 || token.isCancellationRequested) return;

		const state = new EditorStateCancellationTokenSource(this.editor, CodeEditorStateFlag.Value | CodeEditorStateFlag.Selection, undefined, token);
		let edit: T;
		try {
			edit = await resolve(candidate, state.token);
		} catch (error) {
			if (!state.token.isCancellationRequested) this.notifications.error(localize('dropOrPaste.resolveFailed', 'Could not resolve edit: {0}', String(error)));
			return;
		} finally {
			state.dispose();
		}
		if (state.token.isCancellationRequested || model !== this.editor.getModel()) return;

		let combined: WorkspaceEdit;
		let snippet: Snippet | undefined;
		try {
			snippet = typeof edit.insertText === 'string'
				? undefined
				: parseSnippet(edit.insertText.snippet, { variables: createSnippetVariables(model.uri), allowUnresolvedVariables: true });
			combined = createCombinedWorkspaceEdit(model.uri, ranges, snippet ? { ...edit, insertText: snippet.text } : edit);
		} catch (error) {
			this.notifications.error(localize('dropOrPaste.invalidEdit', 'Could not prepare edit: {0}', String(error)));
			return;
		}
		const snippetController = snippet?.placeholderGroups.length ? SnippetController2.get(this.editor) : undefined;
		if (snippet?.placeholderGroups.length && !snippetController) {
			this.notifications.error(localize('dropOrPaste.snippetUnavailable', 'Snippet navigation is unavailable in this editor.'));
			return;
		}
		const resourceEdits = combined.edits.map(entry => toResourceEdit(entry));
		const tracking = model.deltaDecorations([], ranges.map(range => ({
			range,
			options: {
				description: 'post-edit-selector-anchor',
				stickiness: TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
			},
		})));
		let anchor: Range;
		let insertionStarts: number[];
		let undo: () => Promise<void>;
		const abort = new AbortController();
		const cancellation = token.onCancellationRequested(() => abort.abort());
		try {
			const result = await this.bulkEdits.apply(resourceEdits, { editor: this.editor, token: abort.signal });
			if (!result.isApplied || token.isCancellationRequested) return;
			undo = result.undo;
			anchor = model.getDecorationRange(tracking[0]!) ?? ranges[0]!;
			insertionStarts = tracking.map((id, index) => model.offsetAt((model.getDecorationRange(id) ?? ranges[index]!).getStartPosition()));
		} catch (error) {
			this.notifications.error(localize('dropOrPaste.applyFailed', 'Could not apply edit: {0}', String(error)));
			return;
		} finally {
			cancellation.dispose();
			model.deltaDecorations(tracking, []);
		}

		this.editor.focus();
		if (snippetController && snippet) snippetController.startSession(model, insertionStarts, snippet);
		else this.editor.setPosition(anchor.getEndPosition());
		if (!canShowWidget || edits.allEdits.length < 2) return;
		this.widget.value = new PostEditWidget(this.editor, this.id, anchor, this.label, edits, newIndex => {
			if (newIndex === edits.activeEditIndex) return;
			this.clear();
			if (this.editor.getModel() !== model) return;
			snippetController?.cancel();
			void (async () => {
				try {
					await undo();
					await this.applyEditAndShowIfNeeded(ranges, { allEdits: edits.allEdits, activeEditIndex: newIndex }, canShowWidget, resolve, token);
				} catch (error) {
					this.notifications.error(localize('dropOrPaste.switchFailed', 'Could not change edit: {0}', String(error)));
				}
			})();
		}, () => this.clear());
		this.visible.set(true);
	}
}

function toResourceEdit(entry: WorkspaceEditEntry): ResourceTextEdit | ResourceFileEdit {
	return 'textEdit' in entry
		? ResourceTextEdit.lift(entry)
		: ResourceFileEdit.lift(entry);
}
