import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageInlayHint } from '../../../common/languages.js';
import "./media/inlayHints.css";
import { registerEditorContribution } from "../../../browser/editorFeatureRegistration.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Position } from "../../../common/core/position.js";
import { type View } from "../../../browser/view.js";
import { addDisposableListener, ModifierKeyEmitter } from "../../../../base/browser/dom.js";
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { ILanguageFeatureDebounceService, type IFeatureDebounceInformation } from '../../../common/services/languageFeatureDebounce.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { StopWatch } from '../../../../base/common/stopwatch.js';
import { Range } from '../../../common/core/range.js';
import { InjectedTextCursorStops } from '../../../common/model.js';
import type { IEditorDecorationsCollection } from '../../../common/editorCommon.js';
import { Emitter } from '../../../../base/common/event.js';

/** Owns versioned hints; the editor's line projection owns their inline geometry. */
export class InlayHintsController extends Disposable {
	public static readonly ID = 'editor.contrib.inlayHints';
	public static get(editor: ICodeEditor): InlayHintsController | null {
		return editor.getContribution<InlayHintsController>(InlayHintsController.ID);
	}

	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeHints = this.changed.event;
	private hints: readonly LanguageInlayHint[] = [];
	private readonly decorations: IEditorDecorationsCollection;
	private rendered: readonly LanguageInlayHint[] | undefined;
	private visible = false;
	private request: AbortController | undefined;
	private readonly debounce: IFeatureDebounceInformation;
	private readonly scheduler: RunOnceScheduler;
	private readonly modifierKeys: ModifierKeyEmitter;

	constructor(
		private readonly viewport: View,
		private readonly editor: ICodeEditor,
		private readonly onError: (error: unknown) => void,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@ILanguageFeatureDebounceService debounceService: ILanguageFeatureDebounceService,
	) {
		super();
		if (editor.getModel() !== viewport.textModel) throw new TypeError('Inlay hint dependencies must share one text model');
		this.decorations = editor.createDecorationsCollection();
		this.debounce = debounceService.for(languageFeaturesService.inlayHintsProvider, 'Inlay hints', { min: 25, max: 500 });
		this.scheduler = this._register(new RunOnceScheduler(() => void this.refresh(), this.debounce.default()));
		this.modifierKeys = ModifierKeyEmitter.getInstance(viewport.domNode.domNode.ownerDocument.defaultView!);
		this._register(this.modifierKeys.event(() => this.render()));
		this._register(toDisposable(() => this.clear()));
		this._register(addDisposableListener<PointerEvent>(viewport.domNode.domNode, 'pointerover', event => {
			const element = event.target instanceof viewport.domNode.domNode.ownerDocument.defaultView!.HTMLElement ? event.target : undefined;
			if (!element?.classList.contains('stanza-editor-inlay-hint')) return;
			const target = viewport.getNearestTargetAtClientPoint(event);
			const hint = target?.injectedText?.options.attachedData;
			if (this.hints.includes(hint as LanguageInlayHint) && (hint as LanguageInlayHint).tooltip) {
				element.title = (hint as LanguageInlayHint).tooltip!;
			}
		}));
		this._register(viewport.textModel.onDidChangeContent(() => this.schedule()));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.schedule()));
		this._register(viewport.textModel.onWillDispose(() => this.dispose()));
		this._register(languageFeaturesService.inlayHintsProvider.onDidChange(() => this.schedule()));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.inlayHints)) this.schedule();
		}));
		this.schedule();
	}

	private schedule(): void {
		this.clear();
		const model = this.viewport.textModel;
		if (this.isDisposed || model.isDisposed() || this.editor.getOption(EditorOption.inlayHints).enabled === 'off') return;
		if (this.languageFeaturesService.inlayHintsProvider.has(model)) {
			this.scheduler.schedule(this.debounce.get(model));
		}
	}

	/** Returns only the current model revision's hints, including hints hidden by a modifier. */
	public getInlayHintsForLine(line: number): readonly LanguageInlayHint[] {
		return this.hints.filter(hint => hint.position.lineNumber === line).sort((left, right) => left.position.column - right.position.column);
	}

	private async refresh(): Promise<void> {
		const model = this.viewport.textModel;
		if (this.isDisposed || model.isDisposed()) return;
		const controller = this.request = new AbortController();
		const request = {
			...createLanguageFeatureRequest(model, model.getLanguageId(), controller.signal),
			resource: model.uri,
			range: model.getFullModelRange(),
		};
		const duration = StopWatch.create();
		const hints: LanguageInlayHint[] = [];
		try {
			for (const provider of this.languageFeaturesService.inlayHintsProvider.ordered(model)) {
				if (!isLanguageFeatureRequestCurrent(request)) return;
				try {
					const result = await provider.provideInlayHints(request, controller.signal);
					if (!isLanguageFeatureRequestCurrent(request)) return;
					hints.push(...result.map(normalizeLanguageInlayHint));
				} catch (error) {
					if (!isLanguageFeatureRequestCurrent(request)) return;
					this.onError(error);
				}
			}
			if (!isLanguageFeatureRequestCurrent(request)) return;
			this.debounce.update(model, duration.elapsed());
			this.hints = hints;
			this.render();
			this.changed.fire();
		} catch (error) {
			if (isLanguageFeatureRequestCurrent(request)) {
				this.clear();
				this.onError(error);
			}
		} finally {
			if (this.request === controller) this.request = undefined;
		}
	}

	private render(): void {
		const mode = this.editor.getOption(EditorOption.inlayHints).enabled;
		const pressed = this.modifierKeys.keyStatus.ctrlKey && this.modifierKeys.keyStatus.altKey;
		const visible = mode === 'on' || (mode === 'offUnlessPressed' && pressed) || (mode === 'onUnlessPressed' && !pressed);
		if (this.rendered === this.hints && this.visible === visible) return;
		this.rendered = this.hints;
		this.visible = visible;
		this.decorations.set(visible ? this.hints.map(hint => ({
			range: Range.fromPositions(hint.position),
			options: {
				description: 'inlay-hint', showIfCollapsed: true,
				before: {
					content: `${hint.paddingLeft ? '\u00a0' : ''}${typeof hint.label === 'string' ? hint.label : hint.label.map(part => part.value).join('')}${hint.paddingRight ? '\u00a0' : ''}`,
					inlineClassName: 'stanza-editor-inlay-hint',
					cursorStops: InjectedTextCursorStops.None, attachedData: hint,
				},
			},
		})) : []);
	}

	private clear(): void {
		this.scheduler.cancel();
		this.request?.abort();
		this.request = undefined;
		this.hints = [];
		this.rendered = undefined;
		this.decorations.clear();
		this.changed.fire();
	}
}

function normalizeLanguageInlayHint(hint: LanguageInlayHint): LanguageInlayHint {
	if (!hint || !Number.isSafeInteger(hint.position?.lineNumber) || !Number.isSafeInteger(hint.position?.column)
		|| hint.position.lineNumber < 1 || hint.position.column < 1) {
		throw new TypeError("Inlay hint has invalid position");
	}
	return Object.freeze({
		position: new Position(hint.position.lineNumber, hint.position.column),
		label: typeof hint.label === "string" ? hint.label : Object.freeze(hint.label.map(part => Object.freeze({
			value: part.value,
			...(part.location ? { location: part.location } : {}),
		}))),
		...(hint.kind ? { kind: hint.kind } : {}),
		...(hint.tooltip !== undefined ? { tooltip: hint.tooltip } : {}),
		...(hint.paddingLeft !== undefined ? { paddingLeft: hint.paddingLeft } : {}),
		...(hint.paddingRight !== undefined ? { paddingRight: hint.paddingRight } : {}),
	});
}

registerEditorContribution({
	id: InlayHintsController.ID, install: context => {
		if (context.kind !== "text" || context.model.largeFile.tooLargeForTokenization) return;
		return context.instantiationService.createInstance(InlayHintsController, context.view, context.editor, context.onLanguageError);
	}
});
