import { isMacintosh, isWindows } from '../../../base/common/platform.js';
import { EditorZoom } from './editorZoom.js';
import type { EditorOption, FindComputedEditorOptionValueById } from './editorOptions.js';

/** Empirical ratio used when a line height is not explicitly configured. */
export const GOLDEN_LINE_HEIGHT_RATIO = isMacintosh ? 1.5 : 1.35;

/** Smallest line height accepted by the editor font contract. */
export const MINIMUM_LINE_HEIGHT = 8;

/** The validated option lookup consumed by font construction helpers. */
export interface IValidatedEditorOptions {
	get<T extends EditorOption>(id: T): FindComputedEditorOptionValueById<T>;
}

/** The font information needed before browser-specific glyph measurements exist. */
export class BareFontInfo {
	readonly _bareFontInfoBrand: void = undefined;

	/** Creates normalized font information from validated editor settings. */
	public static _create(
		fontFamily: string,
		fontWeight: string,
		fontSize: number,
		fontFeatureSettings: string,
		fontVariationSettings: string,
		lineHeight: number,
		letterSpacing: number,
		pixelRatio: number,
		ignoreEditorZoom: boolean,
	): BareFontInfo {
		if (lineHeight === 0) {
			lineHeight = GOLDEN_LINE_HEIGHT_RATIO * fontSize;
		} else if (lineHeight < MINIMUM_LINE_HEIGHT) {
			lineHeight *= fontSize;
		}

		lineHeight = Math.max(MINIMUM_LINE_HEIGHT, Math.round(lineHeight));
		const zoomMultiplier = 1 + (ignoreEditorZoom ? 0 : EditorZoom.getZoomLevel() * 0.1);
		fontSize *= zoomMultiplier;
		lineHeight *= zoomMultiplier;

		if (fontVariationSettings === FONT_VARIATION_TRANSLATE) {
			if (fontWeight === 'normal' || fontWeight === 'bold') {
				fontVariationSettings = FONT_VARIATION_OFF;
			} else {
				const numericWeight = Number.parseInt(fontWeight, 10);
				fontVariationSettings = Number.isFinite(numericWeight) ? `'wght' ${numericWeight}` : FONT_VARIATION_OFF;
				fontWeight = 'normal';
			}
		}

		return new BareFontInfo({
			pixelRatio,
			fontFamily,
			fontWeight,
			fontSize,
			fontFeatureSettings,
			fontVariationSettings,
			lineHeight,
			letterSpacing,
		});
	}

	private static _wrapInQuotes(fontFamily: string): string {
		if (/[,"']/.test(fontFamily)) return fontFamily;
		if (/[+ ]/.test(fontFamily)) return `"${fontFamily}"`;
		return fontFamily;
	}

	public readonly pixelRatio: number;
	public readonly fontFamily: string;
	public readonly fontWeight: string;
	public readonly fontSize: number;
	public readonly fontFeatureSettings: string;
	public readonly fontVariationSettings: string;
	public readonly lineHeight: number;
	public readonly letterSpacing: number;

	protected constructor(options: {
		pixelRatio: number;
		fontFamily: string;
		fontWeight: string;
		fontSize: number;
		fontFeatureSettings: string;
		fontVariationSettings: string;
		lineHeight: number;
		letterSpacing: number;
	}) {
		this.pixelRatio = finiteOr(options.pixelRatio, 1);
		this.fontFamily = String(options.fontFamily);
		this.fontWeight = String(options.fontWeight);
		this.fontSize = finiteOr(options.fontSize, EDITOR_FONT_DEFAULTS.fontSize);
		this.fontFeatureSettings = String(options.fontFeatureSettings);
		this.fontVariationSettings = String(options.fontVariationSettings);
		this.lineHeight = Math.max(MINIMUM_LINE_HEIGHT, Math.round(finiteOr(options.lineHeight, MINIMUM_LINE_HEIGHT)));
		this.letterSpacing = finiteOr(options.letterSpacing, 0);
	}

	/** Returns a stable identity for the font environment. */
	public getId(): string {
		return [
			this.pixelRatio,
			this.fontFamily,
			this.fontWeight,
			this.fontSize,
			this.fontFeatureSettings,
			this.fontVariationSettings,
			this.lineHeight,
			this.letterSpacing,
		].join('-');
	}

	/** Adds the platform fallback and quotes family names where CSS requires it. */
	public getMassagedFontFamily(): string {
		const fontFamily = BareFontInfo._wrapInQuotes(this.fontFamily);
		if (EDITOR_FONT_DEFAULTS.fontFamily && this.fontFamily !== EDITOR_FONT_DEFAULTS.fontFamily) {
			return `${fontFamily}, ${EDITOR_FONT_DEFAULTS.fontFamily}`;
		}
		return fontFamily;
	}
}

/** Serialized font metrics version; increment when the serialized shape changes. */
export const SERIALIZED_FONT_INFO_VERSION = 2;

/** A fully measured font environment. */
export class FontInfo extends BareFontInfo {
	readonly _editorStylingBrand: void = undefined;

	public readonly version: number = SERIALIZED_FONT_INFO_VERSION;
	public readonly isTrusted: boolean;
	public readonly isMonospace: boolean;
	public readonly typicalHalfwidthCharacterWidth: number;
	public readonly typicalFullwidthCharacterWidth: number;
	public readonly canUseHalfwidthRightwardsArrow: boolean;
	public readonly spaceWidth: number;
	public readonly middotWidth: number;
	public readonly wsmiddotWidth: number;
	public readonly maxDigitWidth: number;

	public constructor(options: {
		pixelRatio: number;
		fontFamily: string;
		fontWeight: string;
		fontSize: number;
		fontFeatureSettings: string;
		fontVariationSettings: string;
		lineHeight: number;
		letterSpacing: number;
		isMonospace: boolean;
		typicalHalfwidthCharacterWidth: number;
		typicalFullwidthCharacterWidth: number;
		canUseHalfwidthRightwardsArrow: boolean;
		spaceWidth: number;
		middotWidth: number;
		wsmiddotWidth: number;
		maxDigitWidth: number;
	},
		isTrusted: boolean,
	) {
		super(options);
		this.isTrusted = isTrusted;
		this.isMonospace = options.isMonospace;
		this.typicalHalfwidthCharacterWidth = options.typicalHalfwidthCharacterWidth;
		this.typicalFullwidthCharacterWidth = options.typicalFullwidthCharacterWidth;
		this.canUseHalfwidthRightwardsArrow = options.canUseHalfwidthRightwardsArrow;
		this.spaceWidth = options.spaceWidth;
		this.middotWidth = options.middotWidth;
		this.wsmiddotWidth = options.wsmiddotWidth;
		this.maxDigitWidth = options.maxDigitWidth;
	}

	/** Compares the font environment and measured representative widths. */
	public equals(other: FontInfo): boolean {
		return this.fontFamily === other.fontFamily &&
			this.fontWeight === other.fontWeight &&
			this.fontSize === other.fontSize &&
			this.fontFeatureSettings === other.fontFeatureSettings &&
			this.fontVariationSettings === other.fontVariationSettings &&
			this.lineHeight === other.lineHeight &&
			this.letterSpacing === other.letterSpacing &&
			this.typicalHalfwidthCharacterWidth === other.typicalHalfwidthCharacterWidth &&
			this.typicalFullwidthCharacterWidth === other.typicalFullwidthCharacterWidth &&
			this.canUseHalfwidthRightwardsArrow === other.canUseHalfwidthRightwardsArrow &&
			this.spaceWidth === other.spaceWidth &&
			this.middotWidth === other.middotWidth &&
			this.wsmiddotWidth === other.wsmiddotWidth &&
			this.maxDigitWidth === other.maxDigitWidth;
	}
}

/** Disables explicit variable-font translation. */
export const FONT_VARIATION_OFF = 'normal';

/** Translates a numeric font weight to a variable-font axis. */
export const FONT_VARIATION_TRANSLATE = 'translate';

/** Windows editor fallback family used by the VS Code-compatible defaults. */
export const DEFAULT_WINDOWS_FONT_FAMILY = 'Consolas, \'Courier New\', monospace';

/** macOS editor fallback family used by the VS Code-compatible defaults. */
export const DEFAULT_MAC_FONT_FAMILY = 'Menlo, Monaco, \'Courier New\', monospace';

/** Linux editor fallback family used by the VS Code-compatible defaults. */
export const DEFAULT_LINUX_FONT_FAMILY = '\'Droid Sans Mono\', monospace';

/** Platform-aware defaults used when a host does not provide font settings. */
export const EDITOR_FONT_DEFAULTS = Object.freeze({
	fontFamily: isMacintosh ? DEFAULT_MAC_FONT_FAMILY : isWindows ? DEFAULT_WINDOWS_FONT_FAMILY : DEFAULT_LINUX_FONT_FAMILY,
	fontWeight: 'normal',
	fontSize: isMacintosh ? 12 : 14,
	lineHeight: 0,
	letterSpacing: 0,
});

function finiteOr(value: number, fallback: number): number {
	return Number.isFinite(value) ? value : fallback;
}
