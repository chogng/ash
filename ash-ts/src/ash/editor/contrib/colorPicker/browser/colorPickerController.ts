import './colorPicker.css';
import { addDisposableListener, stopEvent } from '../../../../base/browser/dom.js';
import { disposableWindowTimeout } from '../../../../base/browser/scheduler.js';
import { Color, RGBA } from '../../../../base/common/color.js';
import { Disposable, MutableDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { MouseTargetType, type ICodeEditor, type IEditorMouseEvent } from '../../../browser/editorBrowser.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { type IColor } from '../../../common/languages.js';
import { type View } from '../../../browser/view.js';
import { registerEditorContribution } from '../../../browser/editorExtensions.js';
import { ColorService, type ColorData } from '../common/languageColors.js';
import { ColorDecorationInjectedTextMarker, ColorDetector } from './colorDetector.js';
import { ColorPickerModel } from './colorPickerModel.js';
import { EditorColorPickerDialog } from './editorColorPickerDialog.js';


export type ColorDecoratorsActivatedOn = 'clickAndHover' | 'click' | 'hover';

/** Coordinates color detection, picker requests, focus, and one atomic editor edit. */
export class ColorPickerController extends Disposable {
	private readonly widget: EditorColorPickerDialog;
	private readonly model = this._register(new MutableDisposable<ColorPickerModel>());
	private readonly hoverTimer = this._register(new MutableDisposable<IDisposable>());
	private presentationRequest: AbortController | undefined;
	private documentColorRequest: AbortController | undefined;
	private activeData: ColorData | undefined;
	private originalText = '';

	constructor(
		private readonly editorInput: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly service: ColorService,
		private readonly detector: ColorDetector,
		private readonly languageId: string,
		private readonly activatedOn: ColorDecoratorsActivatedOn,
		private readonly readOnly: boolean,
		private readonly onError: (error: unknown) => void,
	) {
		super();
		if (viewport.textModel !== editor.getModel()) throw new TypeError('Stanza color picker dependencies must share a text model');
		this.widget = this._register(new EditorColorPickerDialog(
			viewport.domNode.domNode,
			color => this.refreshPresentations(color),
			() => this.apply(),
			() => this.close(true),
		));
		viewport.domNode.domNode.append(this.widget.domNode);
		this._register(addDisposableListener(editorInput, 'keydown', event => this.handleEditorKeyDown(event), true));
		this._register(editor.onMouseDown(event => this.handleEditorMouseDown(event)));
		this._register(addDisposableListener(viewport.domNode.domNode, 'pointerover', event => this.handlePointerOver(event)));
		this._register(addDisposableListener(viewport.domNode.domNode, 'pointerout', event => this.handlePointerOut(event)));
		this._register(addDisposableListener(viewport.domNode.domNode.ownerDocument, 'pointerdown', event => {
			const target = event.target;
			const targetNode = target && typeof (target as Node).nodeType === 'number' ? target as Node : undefined;
			if (!this.widget.visible) return;
			if (targetNode && this.widget.domNode.contains(targetNode)) {
				event.stopPropagation();
				return;
			}
			if (colorSwatch(target)) return;
			this.close(false);
		}, true));
		this._register(viewport.textModel.onDidChangeContent(() => this.close(false)));
		this._register(viewport.onDidChangeLayout(() => this.close(false)));
	}

	async showAtPosition(position: Position, focus = true): Promise<void> {
		this.documentColorRequest?.abort();
		const request = this.documentColorRequest = new AbortController();
		try {
			let data = this.detector.findAtPosition(position);
			if (!data) {
				const colors = await this.service.provideDocumentColors(this.languageId, 'auto', request.signal);
				if (request.signal.aborted) return;
				data = colors.find(candidate => candidate.information.range.containsPosition(position));
			}
			if (!data) {
				this.viewport.announceAccessibilityStatus(localize('noColorAtCursor', 'No color is available at the cursor.'));
				return;
			}
			await this.show(data, focus);
		} catch (error) {
			if (!request.signal.aborted) this.onError(error);
		}
	}

	hide(): void {
		this.close(true);
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
		void this.showAtPosition(this.editor.getSelections()![0]!.getPosition());
	}

	private handleEditorMouseDown(event: IEditorMouseEvent): void {
		if (this.activatedOn === 'hover') return;
		const target = event.target;
		if (target?.type !== MouseTargetType.CONTENT_TEXT || target.detail.injectedText?.options.attachedData !== ColorDecorationInjectedTextMarker || !target.position) return;
		const data = this.detector.findAtPosition(this.viewport.coordinatesConverter.convertViewPositionToModelPosition(target.position));
		if (!data) return;
		event.event.preventDefault();
		event.event.stopPropagation();
		void this.show(data, true);
	}

	private handlePointerOver(event: PointerEvent): void {
		if (this.activatedOn === 'click') return;
		const swatch = colorSwatch(event.target);
		if (!swatch) return;
		const data = this.dataAtPointer(event);
		if (!data) return;
		this.hoverTimer.value = disposableWindowTimeout(this.widget.domNode.ownerDocument.defaultView!, () => {
			this.hoverTimer.clear();
			void this.show(data, false);
		}, 300);
	}

	private handlePointerOut(event: PointerEvent): void {
		const swatch = colorSwatch(event.target);
		const related = event.relatedTarget;
		if (!swatch || related && typeof (related as Node).nodeType === 'number' && swatch.contains(related as Node)) return;
		this.hoverTimer.clear();
	}

	private dataAtPointer(event: PointerEvent): ColorData | undefined {
		const swatch = colorSwatch(event.target);
		if (swatch) {
			const viewPosition = this.viewport.getPositionFromDOMInfo(swatch, 0);
			if (viewPosition && this.viewport.getInjectedTextAt(viewPosition)?.options.attachedData === ColorDecorationInjectedTextMarker) {
				return this.detector.findAtPosition(this.viewport.coordinatesConverter.convertViewPositionToModelPosition(viewPosition));
			}
		}
		const target = this.viewport.getNearestTargetAtClientPoint({ clientX: event.clientX, clientY: event.clientY });
		return target ? this.detector.findAtPosition(target.position) : undefined;
	}

	private async show(data: ColorData, focus: boolean): Promise<void> {
		this.presentationRequest?.abort();
		this.activeData = data;
		this.originalText = this.viewport.textModel.getTextInRange(data.information.range);
		const color = toColor(data.information.color);
		const model = new ColorPickerModel(color, [], 0);
		this.widget.hide();
		this.model.value = model;
		this.widget.show(model, this.widgetPosition(data.information.range.getStartPosition()), focus);
		await this.loadPresentations(model, color);
	}

	private refreshPresentations(color: Color): void {
		const model = this.model.value;
		if (!model) return;
		void this.loadPresentations(model, color);
	}

	private async loadPresentations(model: ColorPickerModel, color: Color): Promise<void> {
		const data = this.activeData;
		if (!data) return;
		this.presentationRequest?.abort();
		const request = this.presentationRequest = new AbortController();
		try {
			const presentations = await this.service.provideColorPresentations(this.languageId, data, toLanguageColor(color), request.signal);
			if (request.signal.aborted || this.model.value !== model) return;
			model.colorPresentations = [...presentations];
			model.guessColorPresentation(color, this.originalText);
		} catch (error) {
			if (!request.signal.aborted) this.onError(error);
		}
	}

	private apply(): void {
		const data = this.activeData;
		const presentation = this.model.value?.presentation;
		if (!data || !presentation) return;
		if (this.readOnly) {
			this.viewport.announceAccessibilityStatus(localize('readOnly', 'The editor is read-only.'));
			this.close(true);
			return;
		}
		const edits = [
			presentation.textEdit ?? { range: data.information.range, text: presentation.label },
			...(presentation.additionalTextEdits ?? []),
		].sort((left, right) => Position.compare(Range.lift(left.range).getStartPosition(), Range.lift(right.range).getStartPosition()) || Position.compare(Range.lift(left.range).getEndPosition(), Range.lift(right.range).getEndPosition()));
		try {
			this.editor.pushUndoStop();
			this.editor.executeEdits('editor.action.colorPicker', edits);
			this.editor.pushUndoStop();
			this.close(true);
		} catch (error) {
			this.onError(error);
		}
	}

	private widgetPosition(position: Position): { readonly left: number; readonly top: number } {
		const coordinates = this.viewport.getPositionContentCoordinates(position);
		const scroll = this.viewport.viewportLayout.scrollPosition;
		const layout = this.viewport.currentLayout.viewportSize;
		const left = Math.min(Math.max(4, coordinates.left - scroll.left), Math.max(4, layout.width - 324));
		const below = coordinates.top - scroll.top + coordinates.height + 4;
		const top = below + 238 <= layout.height ? below : Math.max(4, coordinates.top - scroll.top - 238);
		return Object.freeze({ left, top });
	}

	private close(restoreFocus: boolean): void {
		this.documentColorRequest?.abort();
		this.documentColorRequest = undefined;
		this.presentationRequest?.abort();
		this.presentationRequest = undefined;
		this.hoverTimer.clear();
		this.widget.hide();
		this.model.clear();
		this.activeData = undefined;
		this.originalText = '';
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

registerEditorContribution({
	id: 'editor.contrib.colorPicker',
	install: context => {
		if (context.kind !== 'text') return;
		const service = new ColorService(context.model, context.languageFeaturesService.colorProvider, context.options.input.resource, context.onLanguageError);
		const targetWindow = context.controller.element.ownerDocument.defaultView;
		if (!targetWindow) throw new Error('Color picker requires an attached browser window');
		const detector = context.register(new ColorDetector(
			context.editor,
			context.model,
			service,
			context.languageId,
			targetWindow,
			{
				enabled: context.options.colorDecorators !== false,
				limit: context.options.colorDecoratorsLimit ?? 500,
				defaultColorDecorators: context.options.defaultColorDecorators ?? 'auto',
			},
			context.onLanguageError,
		));
		return new ColorPickerController(
			context.controller.element,
			context.editor,
			context.view,
			service,
			detector,
			context.languageId,
			context.options.colorDecoratorsActivatedOn ?? 'clickAndHover',
			context.options.input.readOnly === true,
			context.onLanguageError,
		);
	},
});
