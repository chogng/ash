import { EditorAction, EditorCommand, registerEditorAction, registerEditorCommand, registerEditorContribution, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { stopEvent } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize2 } from '../../../../nls.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { type View } from '../../../browser/view.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { type LanguageParameterHintsContext } from '../../../common/languages.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { ParameterHintsModel } from './parameterHintsModel.js';
import { ParameterHintsWidget } from './parameterHintsWidget.js';
import { Context } from './provideSignatureHelp.js';

/** Binds the parameter-hint model and widget to editor actions and keyboard commands. */
class ParameterHintsController extends Disposable {
	public static readonly ID = 'editor.controller.parameterHints';

	public static get(editor: ICodeEditor): ParameterHintsController | null {
		return editor.getContribution<ParameterHintsController>(ParameterHintsController.ID);
	}

	private readonly model: ParameterHintsModel;
	private readonly widget: ParameterHintsWidget;

	constructor(
		input: HTMLElement,
		editor: ICodeEditor,
		viewport: View,
		onError: (error: unknown) => void,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		if (viewport.textModel !== editor.getModel()) {
			throw new TypeError('Parameter hints dependencies must share one text model');
		}
		this.model = this._register(new ParameterHintsModel(input, editor, viewport.textModel, onError, languageFeaturesService));
		this.widget = this._register(new ParameterHintsWidget(viewport, editor, this.model, contextKeyService));
		this._register(editor.onKeyDown(keyboardEvent => {
			const event = keyboardEvent.browserEvent;
			if (event.defaultPrevented || event.isComposing) return;
			if (event.key === 'Escape' && (this.model.isActive || this.widget.isVisible)) {
				stopEvent(event);
				editor.trigger('keyboard', 'closeParameterHints', {});
				return;
			}
			if (event.shiftKey && !event.altKey && (event.ctrlKey || event.metaKey) && event.key === ' ') {
				if (!editor.getAction('editor.action.triggerParameterHints')?.isSupported()) return;
				stopEvent(event);
				editor.trigger('keyboard', 'editor.action.triggerParameterHints', {});
				return;
			}
			const hints = this.model.hints;
			if (!this.widget.isVisible || !hints || hints.signatures.length < 2 || event.shiftKey || event.metaKey) return;
			const macControl = isMacintosh && event.ctrlKey && !event.altKey;
			const previous = (!event.ctrlKey && event.key === 'ArrowUp') || (macControl && event.key.toLowerCase() === 'p');
			const next = (!event.ctrlKey && event.key === 'ArrowDown') || (macControl && event.key.toLowerCase() === 'n');
			if (previous || next) {
				stopEvent(event);
				editor.trigger('keyboard', previous ? 'showPrevParameterHint' : 'showNextParameterHint', {});
			}
		}));
		this._register(viewport.textModel.onWillDispose(() => this.dispose()));
	}

	trigger(context: LanguageParameterHintsContext): Promise<void> {
		return this.model.trigger(context);
	}

	cancel(): void {
		this.model.cancel();
	}

	previous(): void {
		this.model.previous();
	}

	next(): void {
		this.model.next();
	}
}

class TriggerParameterHintsAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.triggerParameterHints',
			label: localize2('parameterHints.trigger.label', 'Trigger Parameter Hints'),
			precondition: EditorContextKeys.hasSignatureHelpProvider.isEqualTo(true),
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Space,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	public async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		const controller = ParameterHintsController.get(editor);
		if (controller) {
			editor.focus();
			await controller.trigger({ kind: 'invoke' });
		}
	}
}

registerEditorAction(TriggerParameterHintsAction);

const ParameterHintsCommand = EditorCommand.bindToContribution(ParameterHintsController.get);
registerEditorCommand(new ParameterHintsCommand({
	id: 'closeParameterHints',
	precondition: undefined,
	handler: controller => controller.cancel(),
	kbOpts: {
		kbExpr: ContextKeyExpr.and(EditorContextKeys.focus.isEqualTo(true), Context.Visible.isEqualTo(true)),
		primary: KeyCode.Escape,
		secondary: [KeyMod.Shift | KeyCode.Escape],
		weight: KeybindingWeight.EditorContrib + 75,
	},
}));

registerEditorCommand(new ParameterHintsCommand({
	id: 'showPrevParameterHint',
	precondition: ContextKeyExpr.and(Context.Visible.isEqualTo(true), Context.MultipleSignatures.isEqualTo(true)),
	handler: controller => controller.previous(),
	kbOpts: {
		kbExpr: EditorContextKeys.focus.isEqualTo(true),
		primary: KeyCode.UpArrow,
		secondary: [KeyMod.Alt | KeyCode.UpArrow],
		mac: { primary: KeyCode.UpArrow, secondary: [KeyMod.Alt | KeyCode.UpArrow, KeyMod.WinCtrl | KeyCode.KeyP] },
		weight: KeybindingWeight.EditorContrib + 75,
	},
}));

registerEditorCommand(new ParameterHintsCommand({
	id: 'showNextParameterHint',
	precondition: ContextKeyExpr.and(Context.Visible.isEqualTo(true), Context.MultipleSignatures.isEqualTo(true)),
	handler: controller => controller.next(),
	kbOpts: {
		kbExpr: EditorContextKeys.focus.isEqualTo(true),
		primary: KeyCode.DownArrow,
		secondary: [KeyMod.Alt | KeyCode.DownArrow],
		mac: { primary: KeyCode.DownArrow, secondary: [KeyMod.Alt | KeyCode.DownArrow, KeyMod.WinCtrl | KeyCode.KeyN] },
		weight: KeybindingWeight.EditorContrib + 75,
	},
}));

registerEditorContribution({
	id: ParameterHintsController.ID,
	install: context => {
		if (context.kind !== 'text') {
			return;
		}
		return context.instantiationService.createInstance(
			ParameterHintsController,
			context.controller.element,
			context.editor,
			context.view,
			context.onLanguageError,
		);
	},
});
