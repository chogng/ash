import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorAction, registerEditorAction, registerEditorContribution, type ServicesAccessor } from '../../../browser/editorFeatureRegistration.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { IVersionedEditorWorkerClient } from '../../../browser/services/editorWorkerService.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { formatEditor, formatEditorOnType, FormattingKind, FormattingMode } from './format.js';
import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';

export class FormatOnType extends Disposable {
	public static readonly ID = 'editor.contrib.autoFormat';
	private pending: CancellationTokenSource | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly onError: (error: unknown) => void,
		@ILanguageFeaturesService private readonly features: ILanguageFeaturesService,
		@IVersionedEditorWorkerClient private readonly worker: IVersionedEditorWorkerClient,
	) {
		super();
		this._register(editor.onDidType(text => {
			this.cancel();
			void this.trigger(text).catch(error => { if (!this.isDisposed) this.onError(error); });
		}));
		this._register(editor.onDidChangeConfiguration(() => this.cancel()));
		this._register(features.onTypeFormattingEditProvider.onDidChange(() => this.cancel()));
		const model = editor.getModel();
		if (model) this._register(model.onDidChangeLanguage(() => this.cancel()));
		this._register(editor.onDidCompositionStart(() => this.cancel()));
		this._register(toDisposable(() => this.cancel()));
	}

	private cancel(): void {
		this.pending?.dispose(true);
		this.pending = undefined;
	}

	private async trigger(text: string): Promise<void> {
		const model = this.editor.getModel();
		const selections = this.editor.getSelections();
		if (!model || !text || !this.editor.getOption(EditorOption.formatOnType) || this.editor.getOption(EditorOption.readOnly)
			|| !selections?.length || selections.some(selection => !selection.isEmpty())) return;
		const source = new CancellationTokenSource();
		this.pending = source;
		try {
			await formatEditorOnType(this.editor, this.features, this.worker, text, source.token);
		} catch (error) {
			if (!source.token.isCancellationRequested) throw error;
		} finally {
			if (this.pending === source) this.cancel();
		}
	}
}

registerEditorContribution({
	id: FormatOnType.ID,
	install: context => context.instantiationService.createInstance(FormatOnType, context.editor, context.onLanguageError),
});

class FormatDocumentAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.formatDocument',
			contextMenuOpts: { group: '1_modification', order: 1.3 },
			label: localize2('formatDocument.label', 'Format Document'),
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasDocumentFormattingProvider.isEqualTo(true)),
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	public async run(accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		if (!editor.getModel()) {
			return;
		}
		const signals = accessor.get(IAccessibilitySignalService);
		const applied = await formatEditor(editor, accessor.get(ILanguageFeaturesService), accessor.get(IVersionedEditorWorkerClient), FormattingKind.File);
		if (applied) { void signals.playSignal(AccessibilitySignal.format); }
	}
}

const formatDocumentAction = registerEditorAction(FormatDocumentAction);

class FormatSelectionAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.formatSelection',
			contextMenuOpts: { group: '1_modification', order: 1.31, when: EditorContextKeys.hasNonEmptySelection.isEqualTo(true) },
			label: localize2('formatSelection.label', 'Format Selection'),
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasDocumentSelectionFormattingProvider.isEqualTo(true)),
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyF),
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	public async run(accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		if (!editor.getModel()) {
			return;
		}
		const signals = accessor.get(IAccessibilitySignalService);
		const applied = await formatEditor(editor, accessor.get(ILanguageFeaturesService), accessor.get(IVersionedEditorWorkerClient), FormattingKind.Selection);
		if (applied) { void signals.playSignal(AccessibilitySignal.format); }
	}
}

registerEditorAction(FormatSelectionAction);

registerEditorContribution({
	id: 'editor.contrib.format', install: context => {
		if (context.kind !== 'text') {
			return;
		}
		context.register(context.editor.onKeyDown(event => {
			if (event.browserEvent.defaultPrevented || event.isComposing || event.altKey || (!event.ctrlKey && !event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'i') return;
			const action = context.editor.getAction(formatDocumentAction.id);
			if (!action?.isSupported()) return;
			event.stop();
			void action.run().catch(context.onLanguageError);
		}));
		if (!context.options.formatOnSave || !context.registerBeforeSave) {
			return;
		}
		context.register(context.registerBeforeSave(async () => {
			await formatEditor(context.editor, context.languageFeaturesService, context.editorWorker, FormattingKind.File, FormattingMode.Silent).catch(context.onLanguageError);
		}));
	}
});
