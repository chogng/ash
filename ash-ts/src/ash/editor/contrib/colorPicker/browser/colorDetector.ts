import { disposableWindowTimeout } from '../../../../base/browser/scheduler.js';
import { MutableDisposable, Disposable, DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { DynamicCssRules } from '../../../browser/editorDom.js';
import { type Position } from '../../../common/core/position.js';
import { TextDecorationCollection, type TextDecorationSnapshot } from '../../../common/model/decorationCollection.js';
import { type TextModel } from '../../../common/model/textModel.js';

import { ColorService, type ColorData, type DefaultColorDecoratorsEnablement } from '../common/languageColors.js';
import { TrackedRangeStickiness } from '../../../common/model.js';

export const ColorDecorationInjectedTextMarker = Object.freeze({});

export interface ColorDetectorOptions {
	readonly enabled: boolean;
	readonly limit: number;
	readonly defaultColorDecorators: DefaultColorDecoratorsEnablement;
}

/** Owns provider refresh, version cancellation, tracked ranges, and color-swatch metadata. */
export class ColorDetector extends Disposable {
	private readonly decorations: TextDecorationCollection<ColorData>;
	private readonly dynamicCssRules: DynamicCssRules;
	private readonly colorDecorationClassRefs: DisposableStore;
	private readonly refreshTimer = this._register(new MutableDisposable<IDisposable>());
	private request: AbortController | undefined;
	private detectedCount = 0;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly model: TextModel,
		private readonly service: ColorService,
		private readonly targetWindow: Window,
		private readonly options: ColorDetectorOptions,
		private readonly onError: (error: unknown) => void,
	) {
		super();
		if (!Number.isSafeInteger(options.limit) || options.limit < 0) throw new RangeError('Color decorator limit must be a non-negative integer');
		this.decorations = this._register(new TextDecorationCollection<ColorData>(model));
		this.dynamicCssRules = this._register(new DynamicCssRules(editor));
		this.colorDecorationClassRefs = this._register(new DisposableStore());
		this._register(model.onDidChangeContent(() => this.scheduleRefresh(250)));
		const refreshProviders = () => {
			this.decorations.clear();
			this.colorDecorationClassRefs.clear();
			this.detectedCount = 0;
			this.scheduleRefresh(0);
		};
		this._register(model.onDidChangeLanguage(refreshProviders));
		this._register(model.onWillDispose(() => {
			this.request?.abort();
			this.refreshTimer.clear();
		}));
		this._register(service.onDidChange(refreshProviders));
		this.scheduleRefresh(0);
	}

	get totalColorCount(): number {
		return this.detectedCount;
	}

	get isLimited(): boolean {
		return this.detectedCount > this.options.limit;
	}

	findAtPosition(position: Position): ColorData | undefined {
		const decoration = this.decorations.decorations.find(candidate => candidate.range.containsPosition(position));
		return decoration ? colorDataAtCurrentRange(decoration) : undefined;
	}

	refresh(): void {
		this.assertNotDisposed();
		this.refreshTimer.clear();
		this.request?.abort();
		if (!this.options.enabled || this.model.largeFile.tooLargeForTokenization) {
			this.detectedCount = 0;
			this.colorDecorationClassRefs.clear();
			this.decorations.clear();
			return;
		}
		const request = this.request = new AbortController();
		void this.service.provideDocumentColors(this.model.getLanguageId(), this.options.defaultColorDecorators, request.signal).then(colors => {
			if (request.signal.aborted || this.isDisposed) return;
			this.detectedCount = colors.length;
			this.colorDecorationClassRefs.clear();
			this.decorations.replaceAll(colors.slice(0, this.options.limit).map(data => {
				const ref = this.colorDecorationClassRefs.add(this.dynamicCssRules.createClassNameRef({
					backgroundColor: colorToCss(data.information.color),
				}));
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
			}));
		}, error => {
			if (!request.signal.aborted) this.onError(error);
		});
	}

	private scheduleRefresh(delay: number): void {
		this.request?.abort();
		if (this.model.isDisposed()) return;
		this.refreshTimer.value = disposableWindowTimeout(this.targetWindow, () => {
			this.refreshTimer.clear();
			this.refresh();
		}, delay);
	}

	protected override disposeCore(): void {
		this.request?.abort();
		this.request = undefined;
		super.disposeCore();
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
