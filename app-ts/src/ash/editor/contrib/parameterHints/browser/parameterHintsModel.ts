import { getActiveElement } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { TextModelChangeReason, type TextModelChange } from '../../../common/core/textChange.js';
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageParameterHints, type LanguageParameterHintsContext, type LanguageParameterHintsRequest } from '../../../common/languages.js';
import { type TextModel } from '../../../common/model/textModel.js';
import { type ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { provideSignatureHelp } from './provideSignatureHelp.js';

/** Owns one editor's parameter-hint triggers, requests and active result. */
export class ParameterHintsModel extends Disposable {
	private readonly changedHints = this._register(new Emitter<LanguageParameterHints | undefined>());
	readonly onChangedHints = this.changedHints.event;
	private readonly scheduler: RunOnceScheduler;
	private currentHints: LanguageParameterHints | undefined;
	private pending: LanguageParameterHintsContext | undefined;
	private request: AbortController | undefined;

	constructor(
		private readonly input: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly textModel: TextModel,
		private readonly onError: (error: unknown) => void,
		private readonly languageFeaturesService: ILanguageFeaturesService,
	) {
		super();
		this.scheduler = this._register(new RunOnceScheduler(() => {
			const context = this.pending;
			if (context) void this.refresh(context);
		}, 0));
		this._register(editor.onDidBlurEditorWidget(() => this.cancel()));
		this._register(editor.onDidChangeModel(() => this.cancel()));
		this._register(editor.onDidChangeCursorSelection(event => {
			// Typing updates content and selection together; only a separate move cancels hints.
			if (event.modelVersionId === event.oldModelVersionId) this.cancel();
		}));
		this._register(textModel.onDidChangeContent(change => this.onContentChange(change)));
		this._register(textModel.onDidChangeLanguage(() => this.cancel()));
		this._register(textModel.onWillDispose(() => this.dispose()));
		this._register(languageFeaturesService.signatureHelpProvider.onDidChange(() => this.cancel()));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.parameterHints)) this.cancel();
		}));
	}

	get hints(): LanguageParameterHints | undefined {
		return this.currentHints;
	}

	get isActive(): boolean {
		return !!this.request || !!this.pending || !!this.currentHints;
	}

	trigger(context: LanguageParameterHintsContext): Promise<void> {
		return this.refresh(context);
	}

	cancel(): void {
		this.scheduler.cancel();
		this.pending = undefined;
		this.request?.abort();
		this.request = undefined;
		this.currentHints = undefined;
		this.changedHints.fire(undefined);
	}

	previous(): void {
		this.move(-1);
	}

	next(): void {
		this.move(1);
	}

	private move(delta: number): void {
		const hints = this.currentHints;
		if (!hints || this.isDisposed) return;
		const count = hints.signatures.length;
		const next = (hints.activeSignature ?? 0) + delta;
		if ((next < 0 || next >= count) && !this.editor.getOption(EditorOption.parameterHints).cycle) {
			this.cancel();
			return;
		}
		this.currentHints = Object.freeze({ ...hints, activeSignature: (next + count) % count });
		this.changedHints.fire(this.currentHints);
	}

	private canRequest(): boolean {
		return !this.isDisposed && !this.textModel.isDisposed()
			&& this.editor.getModel() === this.textModel
			&& this.editor.getOption(EditorOption.parameterHints).enabled
			&& this.input.contains(getActiveElement(this.input.ownerDocument));
	}

	private onContentChange(change: TextModelChange): void {
		const active = this.isActive;
		const pending = this.pending;
		const activeSignatureHelp = this.currentHints ?? pending?.activeSignatureHelp;
		this.cancel();
		if (change.reason !== TextModelChangeReason.Edit || !this.canRequest()) return;
		const inserted = change.changes.length === 1 ? change.changes[0]!.text : '';
		const providers = this.languageFeaturesService.signatureHelpProvider.ordered(this.textModel);
		const triggerCharacter = [...inserted].reverse().find(character => providers.some(provider =>
			provider.signatureHelpTriggerCharacters?.includes(character)
			|| (active && provider.signatureHelpRetriggerCharacters?.includes(character)),
		));
		if (triggerCharacter !== undefined) {
			this.pending = { kind: 'triggerCharacter', triggerCharacter, isRetrigger: active, activeSignatureHelp };
		} else if (active) {
			this.pending = { ...(pending ?? { kind: 'contentChange' }), isRetrigger: active, activeSignatureHelp };
		}
		if (this.pending) this.scheduler.schedule();
	}

	private async refresh(context: LanguageParameterHintsContext): Promise<void> {
		const activeSignatureHelp = context.activeSignatureHelp ?? this.currentHints;
		context = Object.freeze({
			...context,
			isRetrigger: context.isRetrigger ?? (!!this.request || !!this.currentHints),
			...(activeSignatureHelp ? { activeSignatureHelp } : {}),
		});
		this.cancel();
		const position = this.editor.getSelections()?.[0]?.getPosition();
		if (!this.canRequest() || !position) return;
		const controller = this.request = new AbortController();
		const request: LanguageParameterHintsRequest = Object.freeze({
			...createLanguageFeatureRequest(this.textModel, this.textModel.getLanguageId(), controller.signal),
			resource: this.textModel.uri,
			position,
			context,
		});
		const hints = await provideSignatureHelp(this.languageFeaturesService.signatureHelpProvider, request, this.onError);
		if (!isLanguageFeatureRequestCurrent(request) || this.request !== controller) return;
		if (!hints) {
			this.cancel();
			return;
		}
		this.currentHints = hints;
		this.changedHints.fire(hints);
	}

	override dispose(): void {
		if (this.isDisposed) return;
		this.cancel();
		super.dispose();
	}
}
