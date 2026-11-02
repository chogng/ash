import type { IJSONSchemaSnippet } from '../common/jsonSchema.js';
import { environment, isMacintosh, isWindows } from '../common/platform.js';
import { mainWindow } from './window.js';

/**
 * Platform-appropriate proportional font family for browser UI.
 *
 * Editor and terminal implementations own their separate monospace defaults.
 */
export const DEFAULT_FONT_FAMILY = isWindows
	? '"Segoe WPC", "Segoe UI", sans-serif'
	: isMacintosh
		? '-apple-system, BlinkMacSystemFont, sans-serif'
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
	try {
		const targetWindow = mainWindow as ILocalFontQueryWindow | undefined;
		if (typeof targetWindow?.queryLocalFonts !== 'function') {
			return [];
		}
		const fonts = await targetWindow.queryLocalFonts();
		return fonts.map((font) => font.family);
	} catch (error) {
		console.error(`Failed to query fonts: ${String(error)}`);
		return [];
	}
}

/** Supplies installed font names to settings completion in the desktop host. */
export async function getFontSnippets(): Promise<IJSONSchemaSnippet[]> {
	// Web font access requires a user gesture; configuration loading must not prompt.
	if (environment.runtime !== 'electron') {
		return [];
	}
	return (await getFonts()).map(family => ({ body: family }));
}
