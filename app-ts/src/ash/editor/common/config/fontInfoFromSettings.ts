import { EditorOption, EditorOptions } from './editorOptions.js';
import { BareFontInfo, type IValidatedEditorOptions } from './fontInfo.js';

/** Builds a bare font descriptor from a normalized editor-option source. */
export function createBareFontInfoFromValidatedSettings(
	options: IValidatedEditorOptions,
	pixelRatio: number,
	ignoreEditorZoom: boolean,
): BareFontInfo {
	const fontFamily = options.get(EditorOption.fontFamily);
	const fontWeight = options.get(EditorOption.fontWeight);
	const fontSize = options.get(EditorOption.fontSize);
	const fontFeatureSettings = options.get(EditorOption.fontLigatures);
	const fontVariationSettings = options.get(EditorOption.fontVariations);
	const lineHeight = options.get(EditorOption.lineHeight);
	const letterSpacing = options.get(EditorOption.letterSpacing);
	return BareFontInfo._create(fontFamily, fontWeight, fontSize, fontFeatureSettings, fontVariationSettings, lineHeight, letterSpacing, pixelRatio, ignoreEditorZoom);
}

/** Builds a bare font descriptor from raw settings at a trust boundary. */
export function createBareFontInfoFromRawSettings(
	options: {
		fontFamily?: unknown;
		fontWeight?: unknown;
		fontSize?: unknown;
		fontLigatures?: unknown;
		fontVariations?: unknown;
		lineHeight?: unknown;
		letterSpacing?: unknown;
	},
	pixelRatio: number,
	ignoreEditorZoom: boolean = false,
): BareFontInfo {
	if (!options || typeof options !== 'object') throw new TypeError('Raw editor font settings must be an object');
	const fontFamily = EditorOptions.fontFamily.validate(options.fontFamily);
	const fontWeight = EditorOptions.fontWeight.validate(options.fontWeight);
	const fontSize = EditorOptions.fontSize.validate(options.fontSize);
	const fontFeatureSettings = EditorOptions.fontLigatures2.validate(options.fontLigatures);
	const fontVariationSettings = EditorOptions.fontVariations.validate(options.fontVariations);
	const lineHeight = EditorOptions.lineHeight.validate(options.lineHeight);
	const letterSpacing = EditorOptions.letterSpacing.validate(options.letterSpacing);
	return BareFontInfo._create(fontFamily, fontWeight, fontSize, fontFeatureSettings, fontVariationSettings, lineHeight, letterSpacing, pixelRatio, ignoreEditorZoom);
}
