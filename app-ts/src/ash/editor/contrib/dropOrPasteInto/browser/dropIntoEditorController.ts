import { addDisposableListener, stopEvent } from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { matchesMimeType, type VSDataTransfer } from '../../../../base/common/dataTransfer.js';
import { onUnexpectedExternalError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService, type IContextKeyService as ContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { type INotificationService, INotificationService as NotificationService } from '../../../../platform/notification/common/notification.js';
import { toExternalVSDataTransfer } from '../../../browser/dataTransfer.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { IBulkEditService, type IBulkEditService as BulkEditService } from '../../../browser/services/bulkEditService.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Position, type IPosition } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { type IEditorContribution } from '../../../common/editorCommon.js';
import { type DocumentDropEdit, type DocumentDropEditProvider } from '../../../common/languages.js';
import { ILanguageFeaturesService, type ILanguageFeaturesService as LanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { CodeEditorStateFlag, EditorStateCancellationTokenSource } from '../../editorState/browser/editorState.js';
import { DefaultTextPasteOrDropEditProvider } from './defaultProviders.js';
import { sortEditsByYieldTo } from './edit.js';
import { PostEditWidgetManager } from './postEditWidget.js';

type DropEditWithProvider = DocumentDropEdit & { readonly provider: DocumentDropEditProvider };
export const dropWidgetVisibleCtx = new RawContextKey<boolean>('dropWidgetVisible', false);
export const changeDropTypeCommandId = 'editor.changeDropType';

/** Owns text and URI drops for one code editor. */
export class DropIntoEditorController extends Disposable implements IEditorContribution {
	public static readonly ID = 'editor.contrib.dropIntoEditorController';
	private readonly postEditWidget: PostEditWidgetManager<DropEditWithProvider>;
	private currentOperation: CancellationTokenSource | undefined;

	public static get(editor: ICodeEditor): DropIntoEditorController | null {
		return editor.getContribution<DropIntoEditorController>(DropIntoEditorController.ID);
	}

	constructor(
		private readonly editor: ICodeEditor,
		@ILanguageFeaturesService private readonly features: LanguageFeaturesService,
		@IBulkEditService bulkEdits: BulkEditService,
		@NotificationService private readonly notifications: INotificationService,
		@IContextKeyService contextKeys: ContextKeyService,
	) {
		super();
		this.postEditWidget = this._register(new PostEditWidgetManager(editor, bulkEdits, notifications,
			'editor.widget.postDropSelector', localize('dropOrPaste.dropOptions', 'Drop options'), dropWidgetVisibleCtx, contextKeys));
		this._register(editor.onDropIntoEditor(event => this.onDrop(event.position, event.event)));
		const domNode = editor.getDomNode();
		if (domNode) this._register(addDisposableListener<DragEvent>(domNode, 'dragover', event => this.onDragOver(event)));
		this._register(toDisposable(() => this.currentOperation?.dispose(true)));
	}

	changeDropType(): void { this.postEditWidget.tryShowSelector(); }
	clearWidgets(): void { this.postEditWidget.clear(); }

	private onDragOver(event: DragEvent): void {
		if (this.editor.getOption(EditorOption.readOnly)
			|| !this.editor.getOption(EditorOption.dropIntoEditor).enabled
			|| event.defaultPrevented) {
			return;
		}
		const dataTransfer = event.dataTransfer;
		if (!dataTransfer) return;
		const model = this.editor.getModel();
		if (!model) return;
		const types = [...dataTransfer.types, ...Array.from(dataTransfer.files, file => file.type), ...(dataTransfer.files.length ? ['files'] : [])];
		const hasPlainTextItem = Array.from(dataTransfer.items).some(item => item.kind === 'string' && item.type === 'text/plain');
		if (!this.features.documentDropEditProvider.ordered(model).some(provider =>
			!(provider instanceof DefaultTextPasteOrDropEditProvider && !hasPlainTextItem)
			&& (!provider.dropMimeTypes || provider.dropMimeTypes.some(type => matchesMimeType(type, types))))) return;
		event.preventDefault();
		dataTransfer.dropEffect = 'copy';
	}

	private onDrop(rawPosition: IPosition, event: DragEvent): void {
		if (this.editor.getOption(EditorOption.readOnly)
			|| !this.editor.getOption(EditorOption.dropIntoEditor).enabled
			|| event.defaultPrevented) {
			return;
		}
		if (!this.editor.hasModel()) return;
		const dataTransfer = event.dataTransfer;
		if (!dataTransfer) return;
		const position = Position.lift(rawPosition);
		const transfer = toExternalVSDataTransfer(dataTransfer);
		const model = this.editor.getModel()!;
		const providers = this.features.documentDropEditProvider.ordered(model)
			.filter(provider => !(provider instanceof DefaultTextPasteOrDropEditProvider && transfer.get('text/plain')?.asFile())
				&& (!provider.dropMimeTypes || provider.dropMimeTypes.some(type => transfer.matches(type))));
		if (providers.length === 0) return;
		stopEvent(event);
		this.editor.focus();
		this.editor.setPosition(position, 'drop');
		this.currentOperation?.dispose(true);
		const operation = new CancellationTokenSource();
		this.currentOperation = operation;
		void this.dropWithProviders(providers, transfer, position, operation)
			.catch(error => this.notifications.error(localize('dropOrPaste.dropFailed', 'Could not drop content: {0}', String(error))))
			.finally(() => {
				if (this.currentOperation === operation) this.currentOperation = undefined;
				operation.dispose();
			});
	}

	private async dropWithProviders(
		providers: readonly DocumentDropEditProvider[],
		transfer: VSDataTransfer,
		position: Position,
		operation: CancellationTokenSource,
	): Promise<void> {
		const model = this.editor.getModel();
		if (!model) return;
		const state = new EditorStateCancellationTokenSource(this.editor, CodeEditorStateFlag.Value | CodeEditorStateFlag.Position, undefined, operation.token);
		using sessions = new DisposableStore();
		let edits: DropEditWithProvider[] = [];
		try {
			const results = await Promise.allSettled(providers.map(async provider => {
				const session = await provider.provideDocumentDropEdits(model, position, transfer, state.token);
				if (session) sessions.add(toDisposable(() => session.dispose()));
				return session?.edits.map(edit => ({ ...edit, provider })) ?? [];
			}));
			if (state.token.isCancellationRequested) return;
			edits = sortEditsByYieldTo(results.flatMap(result => {
				if (result.status === 'fulfilled') return result.value;
				onUnexpectedExternalError(result.reason);
				return [];
			}));
		} finally {
			state.dispose();
		}
		if (operation.token.isCancellationRequested || edits.length === 0) return;
		await this.postEditWidget.applyEditAndShowIfNeeded(
			[Range.fromPositions(position)],
			{ allEdits: edits, activeEditIndex: 0 },
			this.editor.getOption(EditorOption.dropIntoEditor).showDropSelector === 'afterDrop',
			async (edit, token) => edit.provider.resolveDocumentDropEdit
				? { ...edit, ...await edit.provider.resolveDocumentDropEdit(edit, token) }
				: edit,
			operation.token,
		);
	}
}
