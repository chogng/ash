import './colorPicker.css';
import { addDisposableListener, stopEvent } from '../../../../base/browser/dom.js';
import { trackFocus } from '../../../../base/browser/focus.js';
import { Color, RGBA } from '../../../../base/common/color.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { MouseTargetType, type ICodeEditor, type IEditorMouseEvent } from '../../../browser/editorBrowser.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { type IColor } from '../../../common/languages.js';
import { type View } from '../../../browser/view.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { ColorService, DefaultDocumentColorProvider, type ColorData } from '../common/languageColors.js';
import { ColorDecorationInjectedTextMarker, ColorDetector } from './colorDetector.js';
import { ColorPickerModel } from './colorPickerModel.js';
import { ColorPickerWidget } from './colorPickerWidget.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ContentHoverController } from '../../hover/browser/contentHoverController.js';
import type { IEditorHoverRenderContext, IRenderedHoverParts } from '../../hover/browser/hoverTypes.js';
import { TextDecorationCollection } from '../../../common/model/decorationCollection.js';
import { TrackedRangeStickiness } from '../../../common/model.js';


/** Coordinates color detection, picker requests, focus, and one atomic editor edit. */
export class ColorPickerController extends Disposable {
	private readonly widget: ColorPickerWidget;
	private readonly model = this._register(new MutableDisposable<ColorPickerModel>());
	private readonly modelListeners = this._register(new DisposableStore());
	private readonly colorRange: TextDecorationCollection<void>;
	private readonly standaloneVisible: IContextKey<boolean>;
	private readonly standaloneFocused: IContextKey<boolean>;
	private mode: 'standalone' | 'hover' = 'standalone';
	private hoverContext: IEditorHoverRenderContext | undefined;
	private updatingEditor = false;
	private pendingPresentations: Promise<void> | undefined;
	private commitSequence = 0;
	private presentationRequest: AbortController | undefined;
	private documentColorRequest: AbortController | undefined;
	private activeData: ColorData | undefined;
	private insertionRanges: readonly Range[] | undefined;
	private originalText = '';
	private shouldGuessPresentation = false;

	constructor(
		private readonly editorInput: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly service: ColorService,
		private readonly detector: ColorDetector,
		private readonly onError: (error: unknown) => void,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		if (viewport.textModel !== editor.getModel()) throw new TypeError('Stanza color picker dependencies must share a text model');
		this.widget = this._register(instantiationService.createInstance(ColorPickerWidget,
			editor,
			(color: Color) => this.refreshPresentations(color),
			() => this.apply(),
			() => this.close(true),
		));
		this.colorRange = this._register(new TextDecorationCollection<void>(viewport.textModel));
		this.standaloneVisible = EditorContextKeys.standaloneColorPickerVisible.bindTo(contextKeyService);
		this.standaloneFocused = EditorContextKeys.standaloneColorPickerFocused.bindTo(contextKeyService);
		// Overflow widgets still inherit this editor's command context when mounted outside its DOM.
		const widgetContext = this._register(contextKeyService.createScoped(this.widget.domNode));
		const textInputFocus = EditorContextKeys.textInputFocus.bindTo(widgetContext);
		this._register(addDisposableListener(this.widget.domNode, 'focusin', event => {
			const target = event.target as HTMLInputElement;
			textInputFocus.set(target.tagName === 'INPUT' && target.type !== 'range');
		}));
		const focusTracker = this._register(trackFocus(this.widget.domNode));
		this._register(focusTracker.onDidFocus(() => {
			this.standaloneFocused.set(this.mode === 'standalone');
			if (this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.ColorPicker)) {
				this.viewport.announceAccessibilityStatus(localize('colorPicker.helpHint', 'Press Alt+F1 for color picker help.'));
			}
		}));
		this._register(focusTracker.onDidBlur(() => this.standaloneFocused.reset()));
		this._register(addDisposableListener(editorInput, 'keydown', event => this.handleEditorKeyDown(event), true));
		this._register(editor.onMouseDown(event => this.handleEditorMouseDown(event)));
		this._register(addDisposableListener(viewport.domNode.domNode.ownerDocument, 'pointerdown', event => {
			const target = event.target;
			const targetNode = target && typeof (target as Node).nodeType === 'number' ? target as Node : undefined;
			if (!this.widget.visible) return;
			if (targetNode && this.widget.domNode.contains(targetNode)) { return; }
			if (targetNode && this.hoverContext?.container.contains(targetNode)) { return; }
			if (colorSwatch(target)) return;
			this.close(false);
		}, true));
		this._register(viewport.textModel.onDidChangeContent(() => { if (!this.updatingEditor) { this.close(false); } }));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.close(false)));
		this._register(viewport.textModel.onWillDispose(() => this.close(false)));
		this._register(service.onDidChange(() => this.close(false)));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.readOnly) || event.hasChanged(EditorOption.colorDecorators) || event.hasChanged(EditorOption.colorDecoratorsLimit) || event.hasChanged(EditorOption.defaultColorDecorators) || event.hasChanged(EditorOption.colorDecoratorsActivatedOn)) {
				this.close(this.widget.domNode.contains(this.widget.domNode.ownerDocument.activeElement));
			}
		}));
		this._register(editor.onDidChangeCursorPosition(() => { if (!this.updatingEditor) { this.close(false); } }));
		this._register(editor.onDidScrollChange(() => this.close(false)));
		this._register(viewport.onDidChangeLayout(() => this.close(false)));
	}

	public get isStandaloneVisible(): boolean { return this.widget.visible && this.mode === 'standalone'; }
	public getColorData(position: Position): ColorData | null { return this.detector.getColorData(position); }

	public renderHover(context: IEditorHoverRenderContext, data: ColorData): IRenderedHoverParts {
		this.close(false);
		this.mode = 'hover';
		this.hoverContext = context;
		this.initializeModel(data);
		const model = this.model.value!;
		this.widget.showHover(model, context.container);
		this.colorRange.replaceAll([{ range: data.information.range, stickiness: TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges, metadata: undefined }]);
		this.modelListeners.add(model.onColorFlushed(color => { void this.commitHover(model, color); }));
		this.pendingPresentations = this.loadPresentations(model, model.color);
		const dispose = (): void => { if (this.model.value === model) { this.close(false); } };
		return {
			dispose,
			[Symbol.dispose]: dispose,
			focus: () => this.widget.focus(),
			isUpdatingEditor: () => this.updatingEditor,
		};
	}

	async showAtPosition(position: Position, focus = true): Promise<void> {
		this.documentColorRequest?.abort();
		const request = this.documentColorRequest = new AbortController();
		try {
			let insertionRanges: readonly Range[] | undefined;
			let data = this.detector.getColorData(position) ?? undefined;
			if (!data) {
				const colors = await this.service.provideDocumentColors(this.viewport.textModel.getLanguageId(), 'auto', request.signal);
				if (request.signal.aborted) return;
				data = colors.find(candidate => candidate.information.range.containsPosition(position));
			}
			if (!data) {
				const color = Color.white;
				insertionRanges = this.editor.getSelections()!.map(selection => Range.lift(selection));
				data = {
					provider: new DefaultDocumentColorProvider(),
					information: { range: Range.lift(this.editor.getSelection()!), color: toLanguageColor(color) },
				};
			}
			this.documentColorRequest = undefined;
			await this.show(data, focus, insertionRanges);
		} catch (error) {
			if (!request.signal.aborted) this.onError(error);
		}
	}

	hide(): void {
		this.close(true);
	}

	public async showOrFocus(): Promise<void> {
		if (this.isStandaloneVisible) {
			this.widget.focus();
			return;
		}
		await this.showAtPosition(Position.lift(this.editor.getPosition()!));
	}

	public async insertColor(): Promise<void> {
		const model = this.model.value;
		const pending = this.pendingPresentations;
		await pending;
		if (model && this.model.value === model && this.pendingPresentations === pending) { this.apply(); }
	}

	private handleEditorKeyDown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.getModifierState('AltGraph')) return;
		if (event.key === 'Escape' && this.widget.visible) {
			stopEvent(event);
			this.close(true);
			return;
		}
		if (!event.shiftKey || (!event.ctrlKey && !event.metaKey) || event.altKey || event.key.toLowerCase() !== 'c') return;
		stopEvent(event);
		this.editor.trigger('keyboard', 'editor.action.showOrFocusStandaloneColorPicker', {});
	}

	private handleEditorMouseDown(event: IEditorMouseEvent): void {
		if (this.editor.getOption(EditorOption.colorDecoratorsActivatedOn) === 'hover') return;
		const target = event.target;
		if (target?.type !== MouseTargetType.CONTENT_TEXT || target.detail.injectedText?.options.attachedData !== ColorDecorationInjectedTextMarker || !target.position) return;
		const data = this.detector.getColorData(this.viewport.coordinatesConverter.convertViewPositionToModelPosition(target.position));
		if (!data) return;
		event.event.preventDefault();
		event.event.stopPropagation();
		this.editor.getContribution<ContentHoverController>('editor.contrib.hover')!.showContentHover(data.information.range.getStartPosition(), event.event.target as HTMLElement);
	}

	private async show(data: ColorData, focus: boolean, insertionRanges?: readonly Range[]): Promise<void> {
		this.editor.getContribution<ContentHoverController>('editor.contrib.hover')?.hide();
		this.close(false);
		this.mode = 'standalone';
		this.initializeModel(data, insertionRanges);
		const model = this.model.value!;
		this.standaloneVisible.set(true);
		this.widget.show(model, data.information.range.getStartPosition(), focus);
		this.pendingPresentations = this.loadPresentations(model, model.color);
		await this.pendingPresentations;
	}

	private initializeModel(data: ColorData, insertionRanges?: readonly Range[]): void {
		this.documentColorRequest?.abort();
		this.documentColorRequest = undefined;
		this.presentationRequest?.abort();
		this.activeData = data;
		this.insertionRanges = insertionRanges;
		this.originalText = this.viewport.textModel.getTextInRange(data.information.range);
		this.shouldGuessPresentation = true;
		const color = toColor(data.information.color);
		const model = new ColorPickerModel(color, [], 0);
		this.widget.hide();
		this.model.value = model;
	}

	private refreshPresentations(color: Color): void {
		this.commitSequence++;
		const model = this.model.value;
		if (!model) return;
		this.pendingPresentations = this.loadPresentations(model, color);
	}

	private async loadPresentations(model: ColorPickerModel, color: Color): Promise<void> {
		const data = this.activeData;
		if (!data) return;
		this.presentationRequest?.abort();
		const request = this.presentationRequest = new AbortController();
		// Formats contain concrete edits for one color. Invalidate them before requesting another.
		model.colorPresentations = [];
		try {
			const presentations = await this.service.provideColorPresentations(this.viewport.textModel.getLanguageId(), data, toLanguageColor(color), request.signal);
			if (request.signal.aborted || this.model.value !== model) return;
			model.colorPresentations = [...presentations];
			if (this.shouldGuessPresentation && presentations.length > 0) {
				model.guessColorPresentation(color, this.originalText);
				this.shouldGuessPresentation = false;
			}
			this.hoverContext?.onContentsChanged();
		} catch (error) {
			if (!request.signal.aborted) this.onError(error);
		}
	}

	private async commitHover(model: ColorPickerModel, color: Color): Promise<void> {
		const sequence = ++this.commitSequence;
		await this.pendingPresentations;
		if (sequence !== this.commitSequence || this.mode !== 'hover' || this.model.value !== model || !model.color.equals(color)) { return; }
		this.apply();
	}

	private apply(): void {
		const data = this.activeData;
		const presentation = this.model.value?.presentation;
		if (!data || !presentation) return;
		if (this.editor.getOption(EditorOption.readOnly)) {
			this.viewport.announceAccessibilityStatus(localize('readOnly', 'The editor is read-only.'));
			this.close(true);
			return;
		}
		const colorEdits = this.insertionRanges
			? this.insertionRanges.map(range => ({ range, text: presentation.textEdit?.text ?? presentation.label }))
			: [presentation.textEdit ?? { range: data.information.range, text: presentation.label }];
		const edits = [
			...colorEdits,
			...(presentation.additionalTextEdits ?? []),
		].sort((left, right) => Position.compare(Range.lift(left.range).getStartPosition(), Range.lift(right.range).getStartPosition()) || Position.compare(Range.lift(left.range).getEndPosition(), Range.lift(right.range).getEndPosition()));
		try {
			this.updatingEditor = true;
			this.editor.pushUndoStop();
			this.editor.executeEdits('editor.action.colorPicker', edits);
			this.editor.pushUndoStop();
			if (this.mode === 'hover') {
				const range = this.colorRange.decorations[0]!.range;
				this.activeData = { provider: data.provider, information: { color: toLanguageColor(this.model.value!.color), range } };
				this.originalText = this.viewport.textModel.getTextInRange(range);
				// The next edit must use provider ranges from the new document version.
				this.pendingPresentations = this.loadPresentations(this.model.value!, this.model.value!.color);
				this.hoverContext?.onContentsChanged();
			} else {
				this.close(true);
			}
		} catch (error) {
			this.onError(error);
		} finally {
			this.updatingEditor = false;
		}
	}

	private close(restoreFocus: boolean): void {
		this.commitSequence++;
		const hoverContext = this.hoverContext;
		this.hoverContext = undefined;
		this.documentColorRequest?.abort();
		this.documentColorRequest = undefined;
		this.presentationRequest?.abort();
		this.presentationRequest = undefined;
		this.pendingPresentations = undefined;
		this.modelListeners.clear();
		this.widget.hide();
		this.model.clear();
		this.activeData = undefined;
		this.insertionRanges = undefined;
		this.originalText = '';
		this.shouldGuessPresentation = false;
		this.standaloneVisible.reset();
		this.standaloneFocused.reset();
		this.colorRange.clear();
		hoverContext?.hide();
		if (restoreFocus) this.editorInput.focus({ preventScroll: true });
	}

	protected override disposeCore(): void {
		this.close(false);
		super.disposeCore();
	}
}

function toColor(color: IColor): Color {
	return new Color(new RGBA(color.red * 255, color.green * 255, color.blue * 255, color.alpha));
}

function toLanguageColor(color: Color): IColor {
	return Object.freeze({
		red: color.rgba.r / 255,
		green: color.rgba.g / 255,
		blue: color.rgba.b / 255,
		alpha: color.rgba.a,
	});
}

function colorSwatch(target: EventTarget | null): HTMLElement | undefined {
	return target && typeof (target as Element).closest === 'function'
		? (target as Element).closest<HTMLElement>('.colorpicker-color-decoration') ?? undefined
		: undefined;
}
