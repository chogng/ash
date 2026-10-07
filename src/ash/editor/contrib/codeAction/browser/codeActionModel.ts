import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorOption, ShowLightbulbIconMode } from '../../../common/config/editorOptions.js';
import { Range } from '../../../common/core/range.js';
import { type Position } from '../../../common/core/position.js';
import { type TextDecorationCollection } from '../../../common/model/decorationCollection.js';
import { CodeActionTriggerType, createLanguageFeatureRequest, type LanguageCodeActionRequest, type LanguageDiagnostic } from '../../../common/languages.js';
import { CodeActionTriggerSource, type CodeActionSet, type CodeActionTrigger } from '../common/types.js';
import { getCodeActions } from './codeAction.js';

export namespace CodeActionsState {
	export enum Type { Empty, Triggered }
	export const Empty = { type: Type.Empty } as const;
	export class Triggered {
		public readonly type = Type.Triggered;
		constructor(
			public readonly trigger: CodeActionTrigger, public readonly position: Position,
			public readonly actions: Promise<CodeActionSet>, public readonly context: LanguageCodeActionRequest,
			private readonly request: AbortController,
		) { }
		public cancel(): void { this.request.abort(); }
	}
	export type State = typeof Empty | Triggered;
}

/** One request owner for manual menus and automatic suggestions. */
export class CodeActionModel extends Disposable {
	private current: CodeActionsState.State = CodeActionsState.Empty;
	private readonly changed = this._register(new Emitter<CodeActionsState.State>());
	public readonly onDidChangeState = this.changed.event;
	private readonly automatic = this._register(new RunOnceScheduler(() => this.trigger({
		type: CodeActionTriggerType.Auto, triggerAction: CodeActionTriggerSource.Default,
		filter: { includeSourceActions: false },
	}), 250));

	public get state(): CodeActionsState.State { return this.current; }

	constructor(
		private readonly editor: ICodeEditor,
		private readonly diagnostics: TextDecorationCollection<LanguageDiagnostic>,
		private readonly onError: (error: unknown) => void,
		@ILanguageFeaturesService private readonly features: ILanguageFeaturesService,
	) {
		super();
		this._register(toDisposable(() => this.reset()));
		const invalidate = () => { this.reset(); this.scheduleAutomatic(); };
		this._register(editor.onDidChangeModelContent(invalidate));
		this._register(diagnostics.textModel.onDidChangeLanguage(invalidate));
		this._register(diagnostics.textModel.onWillDispose(() => this.reset()));
		this._register(editor.onDidChangeModel(invalidate));
		this._register(editor.onDidChangeCursorSelection(invalidate));
		this._register(editor.onDidBlurEditorWidget(() => {
			this.automatic.cancel();
			// Manual actions hand focus to ActionWidget; that menu owns dismissal and cancellation.
			if (this.current.type === CodeActionsState.Type.Triggered && this.current.trigger.type === CodeActionTriggerType.Auto) { this.reset(); }
		}));
		this._register(editor.onDidFocusEditorText(() => this.scheduleAutomatic()));
		this._register(features.codeActionProvider.onDidChange(invalidate));
		this._register(diagnostics.onDidChange(invalidate));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.readOnly) || event.hasChanged(EditorOption.lightbulb)) { invalidate(); }
		}));
	}

	public trigger(trigger: CodeActionTrigger): CodeActionsState.Triggered | undefined {
		this.reset();
		if (this.isDisposed) { return undefined; }
		const model = this.diagnostics.textModel;
		const range = this.editor.getSelection();
		if (this.editor.getModel() !== model || model.isDisposed() || !range || this.editor.getOption(EditorOption.readOnly)) { return undefined; }
		const request = new AbortController();
		const context: LanguageCodeActionRequest = Object.freeze({
			...createLanguageFeatureRequest(model, model.getLanguageId(), request.signal), resource: model.uri, range,
			...(trigger.filter?.include?.value ? { only: [trigger.filter.include.value] } : {}),
			diagnostics: this.diagnostics.decorations.filter(item => Range.areIntersectingOrTouching(item.range, range)).map(item => item.metadata),
		});
		const state = new CodeActionsState.Triggered(trigger, range.getStartPosition(),
			getCodeActions(this.features.codeActionProvider, context, trigger.filter ?? {}, this.onError), context, request);
		this.current = state;
		this.changed.fire(state);
		return state;
	}

	public reset(): void {
		this.automatic.cancel();
		if (this.current.type === CodeActionsState.Type.Triggered) { this.current.cancel(); }
		this.current = CodeActionsState.Empty;
		this.changed.fire(this.current);
	}

	private scheduleAutomatic(): void {
		const model = this.editor.getModel();
		if (model && this.editor.hasTextFocus() && this.editor.getOption(EditorOption.lightbulb).enabled !== ShowLightbulbIconMode.Off
			&& this.features.codeActionProvider.has(model)) {
			this.automatic.schedule();
		}
	}

}
