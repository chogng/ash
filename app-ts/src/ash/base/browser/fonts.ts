import { isMacintosh, isWindows } from "../common/platform.js";

/**
 * Platform-appropriate proportional font family for browser UI.
 *
 * Editor and terminal implementations own their separate monospace defaults.
 */
export const DEFAULT_FONT_FAMILY = isWindows
	? '"Segoe WPC", "Segoe UI", sans-serif'
	: isMacintosh
		? "-apple-system, BlinkMacSystemFont, sans-serif"
		: 'system-ui, "Ubuntu", "Droid Sans", sans-serif';

interface ILocalFontData {
	readonly family: string;
}

interface ILocalFontQueryWindow extends Window {
	queryLocalFonts?: () => Promise<readonly ILocalFontData[]>;
}

/**
 * Returns locally installed font families when the browser grants access.
 *
 * Unsupported runtimes and denied permission both produce an empty list.
 */
export async function getFonts(): Promise<string[]> {
	const queryLocalFonts =
		(globalThis as unknown as ILocalFontQueryWindow).queryLocalFonts;
	if (!queryLocalFonts) return [];

	try {
		const fonts = await queryLocalFonts.call(globalThis);
		return fonts.map((font) => font.family);
	} catch (error) {
		console.error(`Failed to query fonts: ${String(error)}`);
		return [];
	}
}
