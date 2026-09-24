import { CancellationTokenSource, type CancellationToken } from '../../../../base/common/cancellation.js';
import {
	createFileDataTransferItem,
	createStringDataTransferItem,
	matchesMimeType,
	VSDataTransfer,
	type IReadonlyVSDataTransfer,
} from '../../../../base/common/dataTransfer.js';
import { onUnexpectedExternalError } from '../../../../base/common/errors.js';
import { HierarchicalKind } from '../../../../base/common/hierarchicalKind.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Mimes } from '../../../../base/common/mime.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService, type IContextKeyService as ContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { type INotificationService, INotificationService as NotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickInputService as QuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { type IClipboardCopyEvent, type IClipboardPasteEvent } from '../../../browser/controller/editContext/clipboardUtils.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { IBulkEditService, type IBulkEditService as BulkEditService } from '../../../browser/services/bulkEditService.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Range } from '../../../common/core/range.js';
import { Handler, type IEditorContribution } from '../../../common/editorCommon.js';
import { DocumentPasteTriggerKind, type DocumentPasteContext, type DocumentPasteEdit, type DocumentPasteEditProvider } from '../../../common/languages.js';
import { ILanguageFeaturesService, type ILanguageFeaturesService as LanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { CodeEditorStateFlag, EditorState, EditorStateCancellationTokenSource } from '../../editorState/browser/editorState.js';
import { DefaultTextPasteOrDropEditProvider } from './defaultProviders.js';
import { sortEditsByYieldTo } from './edit.js';
import { PostEditWidgetManager } from './postEditWidget.js';

type PasteEditWithProvider = DocumentPasteEdit & { readonly provider: DocumentPasteEditProvider };
interface PreparedCopy {
	readonly id: string;
	readonly text: string;
	readonly mimeTypes: readonly string[];
	readonly source: CancellationTokenSource;
	readonly results: readonly Promise<IReadonlyVSDataTransfer | undefined>[];
}
// Match the asynchronous preparation to the copied clipboard item, not just its text.
const preparedCopyMime = 'application/x-ash-paste-provider-id';
export const pasteWidgetVisibleCtx = new RawContextKey<boolean>('pasteWidgetVisible', false);
export const changePasteTypeCommandId = 'editor.changePasteType';

export class CopyPasteController extends Disposable implements IEditorContribution {
	public static readonly ID = 'editor.contrib.copyPasteActionController';
	private static preparedCopy: PreparedCopy | undefined;
	private readonly postEditWidget: PostEditWidgetManager<PasteEditWithProvider>;
	private currentOperation: CancellationTokenSource | undefined;

	public static get(editor: ICodeEditor): CopyPasteController | null {
		return editor.getContribution<CopyPasteController>(CopyPasteController.ID);
	}

	constructor(
		private readonly editor: ICodeEditor,
		@ILanguageFeaturesService private readonly features: LanguageFeaturesService,
		@IBulkEditService bulkEdits: BulkEditService,
		@NotificationService private readonly notifications: INotificationService,
		@IQuickInputService private readonly quickInput: QuickInputService,
		@IContextKeyService contextKeys: ContextKeyService,
	) {
		super();
		this.postEditWidget = this._register(new PostEditWidgetManager(editor, bulkEdits, notifications,
			'editor.widget.postPasteSelector', localize('dropOrPaste.pasteOptions', 'Paste options'), pasteWidgetVisibleCtx, contextKeys));
		this._register(editor.onDidPaste(event => this.handlePaste(event)));
		this._register(editor.onWillCopy(event => this.prepareCopy(event)));
		this._register(editor.onWillCut(event => this.prepareCopy(event)));
		this._register(toDisposable(() => this.currentOperation?.dispose(true)));
	}

	changePasteType(): void { this.postEditWidget.tryShowSelector(); }
	clearWidgets(): void { this.postEditWidget.clear(); }

	async pasteAs(only?: HierarchicalKind): Promise<void> {
		const model = this.editor.getModel();
		const selections = this.editor.getSelections();
		if (!model || !selections?.length || this.editor.getOption(EditorOption.readOnly)) return;
		const clipboard = this.editor.getDomNode()?.ownerDocument.defaultView?.navigator.clipboard;
		if (!clipboard?.read) {
			this.notifications.error(localize('dropOrPaste.richClipboardUnavailable', 'Paste As requires clipboard read access.'));
			return;
		}
		this.currentOperation?.dispose(true);
		const operation = new CancellationTokenSource();
		this.currentOperation = operation;
		const readState = new EditorStateCancellationTokenSource(this.editor, CodeEditorStateFlag.Value | CodeEditorStateFlag.Selection, undefined, operation.token);
		const transfer = new VSDataTransfer();
		let preparedId: string | undefined;
		try {
			try {
				for (const clipboardItem of await clipboard.read()) {
					for (const mimeType of clipboardItem.types) {
						const blob = await clipboardItem.getType(mimeType);
						if (mimeType === preparedCopyMime) {
							preparedId = await blob.text();
							continue;
						}
						transfer.append(mimeType, mimeType.startsWith('text/')
							? createStringDataTransferItem(await blob.text())
							: createFileDataTransferItem('clipboard', undefined, async () => new Uint8Array(await blob.arrayBuffer())));
					}
				}
			} catch (error) {
				if (!readState.token.isCancellationRequested) {
					this.notifications.error(localize('dropOrPaste.clipboardReadFailed', 'Could not read the clipboard: {0}', String(error)));
				}
				return;
			}
			if (readState.token.isCancellationRequested) return;
			const copied = CopyPasteController.preparedCopy;
			const clipboardText = await transfer.get(Mimes.text)?.asString();
			if (readState.token.isCancellationRequested) return;
			const prepared = preparedId && copied?.id === preparedId && copied.text === clipboardText ? copied : undefined;
			readState.dispose();
			const availableTypes = [...transfer].map(([type]) => type).concat(prepared?.mimeTypes ?? []);
			const providers = this.features.documentPasteEditProvider.ordered(model)
				.filter(provider => provider.provideDocumentPasteEdits
					&& provider.pasteMimeTypes.some(type => matchesMimeType(type, availableTypes))
					&& (!only || provider.providedPasteEditKinds.some(kind => only.contains(kind))));
			if (providers.length === 0) {
				this.notifications.error(localize('dropOrPaste.noPasteEdit', 'No paste edit is available for this clipboard content.'));
				return;
			}
			await this.pasteWithProviders(providers, transfer, selections.map(selection => Range.lift(selection)), undefined, prepared, operation,
				{ triggerKind: DocumentPasteTriggerKind.PasteAs, only });
		} finally {
			readState.dispose();
			if (this.currentOperation === operation) this.currentOperation = undefined;
			operation.dispose();
		}
	}

	private prepareCopy(event: IClipboardCopyEvent): void {
		const model = this.editor.getModel();
		if (!model) return;
		CopyPasteController.preparedCopy?.source.dispose(true);
		const providers = this.features.documentPasteEditProvider.ordered(model)
			.filter(provider => provider.prepareDocumentPaste);
		if (providers.length === 0) {
			CopyPasteController.preparedCopy = undefined;
			return;
		}
		const id = generateUuid();
		const source = new CancellationTokenSource();
		event.ensureClipboardGetsEditorData();
		event.clipboardData.setData(preparedCopyMime, id);
		const transfer = new VSDataTransfer();
		transfer.append(Mimes.text, createStringDataTransferItem(event.dataToCopy.text));
		if (event.dataToCopy.html) transfer.append(Mimes.html, createStringDataTransferItem(event.dataToCopy.html));
		CopyPasteController.preparedCopy = {
			id,
			text: event.dataToCopy.text,
			mimeTypes: providers.flatMap(provider => provider.copyMimeTypes),
			source,
			results: providers.map(provider => Promise.resolve()
				.then(() => provider.prepareDocumentPaste!(model, event.dataToCopy.sourceRanges, transfer, source.token))
				.catch(error => onUnexpectedExternalError(error))),
		};
	}

	private handlePaste(event: IClipboardPasteEvent): void {
		if (event.isHandled
			|| this.editor.inComposition
			|| this.editor.getOption(EditorOption.readOnly)
			|| !this.editor.getOption(EditorOption.pasteAs).enabled
			|| !this.editor.hasModel()) {
			return;
		}
		const model = this.editor.getModel();
		const selections = this.editor.getSelections();
		if (!model || !selections?.length) return;
		const transfer = event.toExternalVSDataTransfer();
		if (!transfer) return;
		const preparedId = event.clipboardData.getData(preparedCopyMime);
		transfer.delete(preparedCopyMime);
		const prepared = preparedId && CopyPasteController.preparedCopy?.id === preparedId && CopyPasteController.preparedCopy.text === event.text
			? CopyPasteController.preparedCopy : undefined;
		const availableTypes = [...transfer].map(([type]) => type).concat(prepared?.mimeTypes ?? []);
		const providers = this.features.documentPasteEditProvider.ordered(model)
			.filter(provider => provider.provideDocumentPasteEdits && provider.pasteMimeTypes.some(type => matchesMimeType(type, availableTypes)));
		if (providers.length === 0 || (providers.length === 1 && providers[0] instanceof DefaultTextPasteOrDropEditProvider)) return;
		event.setHandled();
		this.currentOperation?.dispose(true);
		const operation = new CancellationTokenSource();
		this.currentOperation = operation;
		void this.pasteWithProviders(providers, transfer, selections.map(selection => Range.lift(selection)), event, prepared, operation,
			{ triggerKind: DocumentPasteTriggerKind.Automatic })
			.catch(error => this.notifications.error(localize('dropOrPaste.pasteFailed', 'Could not paste: {0}', String(error))))
			.finally(() => {
				if (this.currentOperation === operation) this.currentOperation = undefined;
				operation.dispose();
			});
	}

	private async pasteWithProviders(
		providers: readonly DocumentPasteEditProvider[],
		transfer: VSDataTransfer,
		ranges: readonly Range[],
		event: IClipboardPasteEvent | undefined,
		prepared: PreparedCopy | undefined,
		operation: CancellationTokenSource,
		context: DocumentPasteContext,
	): Promise<void> {
		const model = this.editor.getModel();
		if (!model) return;
		const state = new EditorStateCancellationTokenSource(this.editor, CodeEditorStateFlag.Value | CodeEditorStateFlag.Selection, undefined, operation.token);
		using sessions = new DisposableStore();
		let edits: PasteEditWithProvider[] = [];
		try {
			if (prepared) {
				const copied = await Promise.allSettled(prepared.results);
				for (const result of copied.reverse()) {
					if (result.status !== 'fulfilled' || !result.value) continue;
					for (const [type, item] of result.value) transfer.replace(type, item);
				}
			}
			if (state.token.isCancellationRequested) return;
			const supported = providers.filter(provider => provider.pasteMimeTypes.some(type => transfer.matches(type)));
			const results = await Promise.allSettled(supported.map(async provider => {
				const session = await provider.provideDocumentPasteEdits!(model, ranges, transfer, context, state.token);
				if (session) sessions.add(toDisposable(() => session.dispose()));
				return session?.edits.map(edit => ({ ...edit, provider })) ?? [];
			}));
			if (state.token.isCancellationRequested) return;
			edits = sortEditsByYieldTo(results.flatMap(result => {
				if (result.status === 'fulfilled') return result.value;
				onUnexpectedExternalError(result.reason);
				return [];
			}).filter(edit => !context.only || context.only.contains(edit.kind)));
		} finally {
			state.dispose();
		}
		if (operation.token.isCancellationRequested) return;
		if (edits.length === 0 && !event) {
			this.notifications.error(localize('dropOrPaste.noPasteEdit', 'No paste edit is available for this clipboard content.'));
			return;
		}
		if (event && (edits.length === 0 || (edits.length === 1 && edits[0]!.provider instanceof DefaultTextPasteOrDropEditProvider))) {
			this.editor.trigger('paste', Handler.Paste, {
				text: event.text,
				pasteOnNewLine: !!event.metadata?.isFromEmptySelection,
				multicursorText: event.metadata?.multicursorText ?? null,
				mode: event.metadata?.mode ?? null,
			});
			return;
		}
		let selectedEdits = edits;
		let showSelector = this.editor.getOption(EditorOption.pasteAs).showPasteSelector === 'afterPaste';
		if (context.triggerKind === DocumentPasteTriggerKind.PasteAs) {
			const editorState = new EditorState(this.editor, CodeEditorStateFlag.Value | CodeEditorStateFlag.Selection);
			const selected = context.only ? edits[0] : await this.pickPasteEdit(edits, operation.token);
			if (!selected || operation.token.isCancellationRequested || !editorState.validate(this.editor)) return;
			selectedEdits = [selected];
			showSelector = false;
		}
		await this.postEditWidget.applyEditAndShowIfNeeded(
			ranges,
			{ allEdits: selectedEdits, activeEditIndex: 0 },
			showSelector,
			async (edit, token) => edit.provider.resolveDocumentPasteEdit
				? { ...edit, ...await edit.provider.resolveDocumentPasteEdit(edit, token) }
				: edit,
			operation.token,
		);
	}

	private async pickPasteEdit(edits: readonly PasteEditWithProvider[], token: CancellationToken): Promise<PasteEditWithProvider | undefined> {
		if (token.isCancellationRequested) return undefined;
		interface PastePickItem extends IQuickPickItem { readonly edit: PasteEditWithProvider; }
		using picker = this.quickInput.createQuickPick<PastePickItem>();
		picker.ariaLabel = localize('dropOrPaste.pasteAs', 'Paste As...');
		picker.placeholder = localize('dropOrPaste.selectPasteAction', 'Select Paste Action');
		picker.items = edits.map(edit => ({ label: edit.title, description: edit.kind.value, edit }));
		return await new Promise(resolve => {
			const listeners = new DisposableStore();
			let selected: PasteEditWithProvider | undefined;
			listeners.add(picker.onDidAccept(item => { selected = item.edit; picker.hide(); }));
			listeners.add(picker.onDidHide(() => { listeners.dispose(); resolve(selected); }));
			listeners.add(token.onCancellationRequested(() => picker.hide()));
			picker.show();
		});
	}
}
