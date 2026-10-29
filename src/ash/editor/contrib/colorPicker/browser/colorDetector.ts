import { disposableWindowTimeout } from '../../../../base/browser/scheduler.js';
import { MutableDisposable, Disposable, DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { DynamicCssRules } from '../../../browser/editorDom.js';
import { type Position } from '../../../common/core/position.js';
import { TextDecorationCollection, type TextDecorationSnapshot } from '../../../common/model/decorationCollection.js';
import { type TextModel } from '../../../common/model/textModel.js';

import { ColorService, type ColorData } from '../common/languageColors.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { TrackedRangeStickiness } from '../../../common/model.js';
import { Emitter } from '../../../../base/common/event.js';

export const ColorDecorationInjectedTextMarker = Object.freeze({});

/** Owns provider refresh, version cancellation, tracked ranges, and color-swatch metadata. */
export class ColorDetector extends Disposable {
	private static readonly byEditor = new WeakMap<ICodeEditor, ColorDetector>();
	public static get(editor: ICodeEditor): ColorDetector | null {
		return this.byEditor.get(editor) ?? null;
	}
	public readonly limitReporter = this._register(new DecoratorLimitReporter());
	private readonly decorations: TextDecorationCollection<ColorData>;
	private readonly dynamicCssRules: DynamicCssRules;
	private readonly colorDecorationClassRefs: DisposableStore;
	private readonly refreshTimer = this._register(new MutableDisposable<IDisposable>());
	private request: AbortController | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly model: TextModel,
		private readonly service: ColorService,
		private readonly targetWindow: Window,
		private readonly onError: (error: unknown) => void,
	) {
		super();
		ColorDetector.byEditor.set(editor, this);
		this.decorations = this._register(new TextDecorationCollection<ColorData>(model));
		this.dynamicCssRules = this._register(new DynamicCssRules(editor));
		this.colorDecorationClassRefs = this._register(new DisposableStore());
		this._register(model.onDidChangeContent(() => this.scheduleRefresh(250)));
		const refreshProviders = () => {
			this.decorations.clear();
			this.colorDecorationClassRefs.clear();
			this.limitReporter.update(0, false);
			this.scheduleRefresh(0);
		};
		this._register(model.onDidChangeLanguage(refreshProviders));
		this._register(
			model.onWillDispose(() => {
				this.request?.abort();
				this.refreshTimer.clear();
			}),
		);
		this._register(service.onDidChange(refreshProviders));
		this._register(
			editor.onDidChangeConfiguration(event => {
				if (event.hasChanged(EditorOption.colorDecorators) || event.hasChanged(EditorOption.colorDecoratorsLimit) || event.hasChanged(EditorOption.defaultColorDecorators)) {
					refreshProviders();
				}
			}),
		);
		this.scheduleRefresh(0);
	}

	get totalColorCount(): number {
		return this.limitReporter.computed;
	}

	get isLimited(): boolean {
		return this.limitReporter.limited !== false;
	}

	getColorData(position: Position): ColorData | null {
		const decoration = this.decorations.decorations.find(candidate => candidate.range.containsPosition(position));
		return decoration ? colorDataAtCurrentRange(decoration) : null;
	}

	refresh(): void {
		this.assertNotDisposed();
		this.refreshTimer.clear();
		this.request?.abort();
		if (!this.editor.getOption(EditorOption.colorDecorators) || this.model.largeFile.tooLargeForTokenization) {
			this.limitReporter.update(0, false);
			this.colorDecorationClassRefs.clear();
			this.decorations.clear();
			return;
		}
		const request = (this.request = new AbortController());
		void this.service.provideDocumentColors(this.model.getLanguageId(), this.editor.getOption(EditorOption.defaultColorDecorators), request.signal).then(
			colors => {
				if (request.signal.aborted || this.isDisposed) return;
				this.colorDecorationClassRefs.clear();
				this.decorations.replaceAll(
					colors.slice(0, this.editor.getOption(EditorOption.colorDecoratorsLimit)).map(data => {
						const ref = this.colorDecorationClassRefs.add(
							this.dynamicCssRules.createClassNameRef({
								backgroundColor: colorToCss(data.information.color),
							}),
						);
						return {
							range: data.information.range,
							stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
							options: {
								description: 'colorDetector',
								before: {
									content: '\u00a0',
									inlineClassName: `${ref.className} colorpicker-color-decoration`,
									inlineClassNameAffectsLetterSpacing: true,
									attachedData: ColorDecorationInjectedTextMarker,
									widthInEm: 1.2,
								},
								hoverMessage: { value: this.model.getTextInRange(data.information.range) },
							},
							metadata: data,
						};
					}),
				);
				const limit = this.editor.getOption(EditorOption.colorDecoratorsLimit);
				this.limitReporter.update(colors.length, colors.length > limit ? limit : false);
			},
			error => {
				if (!request.signal.aborted) this.onError(error);
			},
		);
	}

	private scheduleRefresh(delay: number): void {
		this.request?.abort();
		this.limitReporter.update(0, false);
		if (this.model.isDisposed()) return;
		this.refreshTimer.value = disposableWindowTimeout(
			this.targetWindow,
			() => {
				this.refreshTimer.clear();
				this.refresh();
			},
			delay,
		);
	}

	protected override disposeCore(): void {
		this.request?.abort();
		this.request = undefined;
		if (ColorDetector.byEditor.get(this.editor) === this) ColorDetector.byEditor.delete(this.editor);
		super.disposeCore();
	}
}

/** Reports the detector's current result; it never stores or recomputes color data. */
export class DecoratorLimitReporter extends Disposable {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private value: { computed: number; limited: number | false } = { computed: 0, limited: false };
	public get computed(): number {
		return this.value.computed;
	}
	public get limited(): number | false {
		return this.value.limited;
	}
	public update(computed: number, limited: number | false): void {
		if (computed === this.value.computed && limited === this.value.limited) return;
		this.value = { computed, limited };
		this.changed.fire();
	}
}

function colorToCss(color: { readonly red: number; readonly green: number; readonly blue: number; readonly alpha: number }): string {
	return `rgba(${Math.round(color.red * 255)}, ${Math.round(color.green * 255)}, ${Math.round(color.blue * 255)}, ${color.alpha})`;
}

function colorDataAtCurrentRange(decoration: TextDecorationSnapshot<ColorData>): ColorData {
	const data = decoration.metadata;
	if (data.information.range.equalsRange(decoration.range)) return data;
	return Object.freeze({
		provider: data.provider,
		information: Object.freeze({ color: data.information.color, range: decoration.range }),
	});
}
