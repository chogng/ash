import { type Event } from '../../../../base/common/event.js';
import { type URI } from '../../../../base/common/uri.js';
import { Range } from '../../../common/core/range.js';
import { PositionOffsetTransformer } from '../../../common/core/text/positionToOffset.js';
import { computeDefaultDocumentColors } from '../../../common/languages/defaultDocumentColorsComputer.js';

import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type IColor, type IColorInformation, type IColorPresentation, type LanguageColorRequest, type LanguageColorPresentationRequest, type LanguageColorProvider } from '../../../common/languages.js';
import { LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import { type TextModel } from '../../../common/model/textModel.js';

export interface ColorData {
	readonly information: IColorInformation & { readonly range: Range };
	readonly provider: LanguageColorProvider;
}

export type DefaultColorDecoratorsEnablement = 'auto' | 'always' | 'never';

/** Resolves version-bound document colors while retaining the provider that owns each presentation. */
export class ColorService {
	private readonly defaultProvider = new DefaultDocumentColorProvider();
	readonly onDidChange: Event<number>;

	constructor(
		private readonly model: TextModel,
		private readonly providers: LanguageFeatureRegistry<LanguageColorProvider>,
		private readonly resource?: URI,
		private readonly onError: (error: unknown) => void = error => console.error('Stanza document color provider failed', error),
	) {
		this.onDidChange = providers.onDidChange;
	}

	async provideDocumentColors(languageId: string, enablement: DefaultColorDecoratorsEnablement, signal: AbortSignal): Promise<readonly ColorData[]> {
		const request = this.createRequest(languageId, signal);
		const result: ColorData[] = [];
		let validProviderFound = false;
		for (const provider of this.providers.ordered(this.model)) {
			const colors = await this.requestDocumentColors(provider, request, signal);
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			if (!colors) continue;
			validProviderFound = true;
			result.push(...this.normalizeColors(colors, provider));
		}
		if (enablement === 'always' || enablement === 'auto' && !validProviderFound) {
			const colors = await this.defaultProvider.provideDocumentColors(request, signal);
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			result.push(...this.normalizeColors(colors, this.defaultProvider));
		}
		return Object.freeze(result);
	}

	async provideColorPresentations(languageId: string, data: ColorData, color: IColor, signal: AbortSignal): Promise<readonly IColorPresentation[]> {
		const request: LanguageColorPresentationRequest = Object.freeze({
			...this.createRequest(languageId, signal),
			color,
			range: data.information.range,
		});
		try {
			const values = await data.provider.provideColorPresentations(request, signal);
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			return Object.freeze((values?.length ? values : createColorPresentations(request.range, color)).map(normalizePresentation));
		} catch (error) {
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			this.onError(error);
			return Object.freeze(createColorPresentations(request.range, color).map(normalizePresentation));
		}
	}

	private createRequest(languageId: string, signal: AbortSignal): LanguageColorRequest {
		return Object.freeze({
			...createLanguageFeatureRequest(this.model, languageId, signal),
			...(this.resource ? { resource: this.resource } : {}),
		});
	}

	private async requestDocumentColors(provider: LanguageColorProvider, request: LanguageColorRequest, signal: AbortSignal): Promise<readonly IColorInformation[] | undefined> {
		try {
			return await provider.provideDocumentColors(request, signal);
		} catch (error) {
			if (!signal.aborted) this.onError(error);
			return undefined;
		}
	}

	private normalizeColors(values: readonly IColorInformation[], provider: LanguageColorProvider): readonly ColorData[] {
		return values.map(value => {
			const range = Range.lift(value.range);
			this.model.offsetAt(range.getStartPosition());
			this.model.offsetAt(range.getEndPosition());
			assertColor(value.color);
			return Object.freeze({
				information: Object.freeze({ range, color: normalizedColor(value.color.red, value.color.green, value.color.blue, value.color.alpha) }),
				provider,
			});
		});
	}
}

/** Detects common CSS color literals when a language does not provide document colors. */
export class DefaultDocumentColorProvider implements LanguageColorProvider {
	provideDocumentColors(request: LanguageColorRequest, signal: AbortSignal): readonly IColorInformation[] {
		signal.throwIfAborted();
		const text = request.snapshot.getText();
		const coordinates = new PositionOffsetTransformer(text);
		return Object.freeze(computeDefaultDocumentColors({
			getValue: () => text,
			findMatches: regex => [...text.matchAll(regex)],
			positionAt: offset => {
				signal.throwIfAborted();
				return coordinates.getPosition(offset);
			},
		}));
	}

	provideColorPresentations(request: LanguageColorPresentationRequest): readonly IColorPresentation[] {
		return createColorPresentations(request.range, request.color);
	}
}

function createColorPresentations(range: Range, color: IColor): readonly IColorPresentation[] {
	const red = Math.round(color.red * 255);
	const green = Math.round(color.green * 255);
	const blue = Math.round(color.blue * 255);
	const alphaByte = Math.round(color.alpha * 255);
	const alpha = rounded(color.alpha, 3);
	const rgb = alphaByte === 255 ? `rgb(${red}, ${green}, ${blue})` : `rgba(${red}, ${green}, ${blue}, ${alpha})`;
	const [hue, saturation, lightness] = rgbToHsl(color);
	const hsl = alphaByte === 255 ? `hsl(${hue}, ${saturation}%, ${lightness}%)` : `hsla(${hue}, ${saturation}%, ${lightness}%, ${alpha})`;
	const hex = `#${[red, green, blue, ...(alphaByte === 255 ? [] : [alphaByte])].map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
	return Object.freeze([rgb, hsl, hex].map(label => Object.freeze({ label, textEdit: Object.freeze({ range, text: label }) })));
}

function rgbToHsl(color: IColor): readonly [number, number, number] {
	const red = color.red;
	const green = color.green;
	const blue = color.blue;
	const maximum = Math.max(red, green, blue);
	const minimum = Math.min(red, green, blue);
	const delta = maximum - minimum;
	const lightness = (maximum + minimum) / 2;
	const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
	let hue = 0;
	if (delta !== 0) {
		if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
		else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
		else hue = 60 * ((red - green) / delta + 4);
	}
	return Object.freeze([Math.round((hue + 360) % 360), Math.round(saturation * 100), Math.round(lightness * 100)]);
}

function normalizePresentation(value: IColorPresentation): IColorPresentation {
	if (!value || typeof value.label !== 'string' || value.label.trim().length === 0) throw new TypeError('Language color presentation must provide a label');
	return {
		label: value.label,
		...(value.textEdit ? { textEdit: { range: value.textEdit.range, text: value.textEdit.text } } : {}),
		...(value.additionalTextEdits ? { additionalTextEdits: [...value.additionalTextEdits] } : {}),
	};
}

function assertColor(value: IColor): void {
	for (const component of [value?.red, value?.green, value?.blue, value?.alpha]) {
		if (!Number.isFinite(component) || component < 0 || component > 1) throw new TypeError('Language color provider must return color components in the range [0, 1]');
	}
}

function normalizedColor(red: number, green: number, blue: number, alpha: number): IColor {
	return Object.freeze({ red, green, blue, alpha });
}

function rounded(value: number, digits: number): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}
