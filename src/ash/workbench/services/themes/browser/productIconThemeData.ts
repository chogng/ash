import type { IconFontDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import type { IconDefinition } from '../../../../base/common/icon.js';
import type { IWorkbenchProductIconTheme } from '../common/workbenchThemeService.js';

const iconIdPattern = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u;
/** Loads prepared font glyphs from an extension product icon theme. */
export class ProductIconThemeData {
	public static async load(id: string, label: string, source: unknown, readResource: (path: string) => Promise<Uint8Array>): Promise<IWorkbenchProductIconTheme> {
		if (typeof source !== 'object' || source === null || Array.isArray(source)) throw new TypeError(`Product icon theme '${id}' must be an object`);
		const fonts: IconFontDefinition[] = [];
		const fontIds = new Map<string, IconFontDefinition>();
		const sources = (source as Record<string, unknown>).fonts;
		if (sources !== undefined && (!Array.isArray(sources) || sources.length > 16)) { throw new TypeError('Product icon fonts must be an array of up to 16 fonts'); }
		for (const [index, candidate] of ((sources ?? []) as unknown[]).entries()) {
			if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) { throw new TypeError('Invalid product icon font'); }
			const font = candidate as Record<string, unknown>;
			if (typeof font.id !== 'string' || !iconIdPattern.test(font.id) || fontIds.has(font.id) || !Array.isArray(font.src) || !font.src.length || font.src.length > 4) { throw new TypeError('Invalid product icon font'); }
			const family = 'ash-product-' + [...id].map(char => char.codePointAt(0)!.toString(16)).join('-') + '-' + index;
			const src: string[] = [];
			for (const candidate of font.src) {
				if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) { throw new TypeError('Invalid icon font source'); }
				const source = candidate as Record<string, unknown>;
				if (!['woff', 'woff2', 'truetype', 'opentype'].includes(source.format as string)) { throw new TypeError('Unsupported icon font format'); }
				src.push(await loadFontSource(source.path, source.format as string, readResource));
			}
			const weight = font.weight === undefined ? 'normal' : font.weight;
			const style = font.style === undefined ? 'normal' : font.style;
			if (typeof weight !== 'string' || !/^(?:normal|bold|[1-9]00)$/u.test(weight) || typeof style !== 'string' || !/^(?:normal|italic|oblique)$/u.test(style)) { throw new TypeError('Invalid icon font style or weight'); }
			const definition = { id: family, src: src.join(','), weight, style };
			fontIds.set(font.id, definition);
			fonts.push(definition);
		}
		const definitions = (source as Record<string, unknown>).iconDefinitions;
		if (typeof definitions !== 'object' || definitions === null || Array.isArray(definitions)) throw new TypeError(`Product icon theme '${id}' requires iconDefinitions`);
		const entries = Object.entries(definitions);
		if (entries.length > 512) throw new RangeError(`Product icon theme '${id}' has too many icons`);
		const icons = new Map<string, IconDefinition>();
		for (const [iconId, value] of entries) {
			if (!iconIdPattern.test(iconId)) throw new TypeError(`Invalid product icon ID '${iconId}'`);
			if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`Product icon '${iconId}' must declare fontCharacter`);
			const definition = value as Record<string, unknown>;
			if (definition.iconPath !== undefined) throw new TypeError(`Product icon '${iconId}' must use a prepared font glyph`);
			const fontId = definition.fontId === undefined ? fontIds.keys().next().value : definition.fontId;
			const family = typeof fontId === 'string' ? fontIds.get(fontId) : undefined;
			if (!family) throw new TypeError('Unknown product icon font');
			icons.set(iconId, fontIconDefinition(family, definition.fontCharacter));
		}
		return Object.freeze({ id, label, icons, fonts });
	}
}

/** Extension icon defaults use the same verified font resources and glyph contract as product icon themes. */
export async function loadExtensionFontIcon(id: string, fontPath: string, character: string, readResource: (path: string) => Promise<Uint8Array>): Promise<{ readonly icon: IconDefinition; readonly font: IconFontDefinition; }> {
	const extension = fontPath.split('.').at(-1)!.toLowerCase();
	const format = { woff: 'woff', woff2: 'woff2', ttf: 'truetype', otf: 'opentype' }[extension];
	if (!format) { throw new TypeError('Unsupported icon font format'); }
	const family = 'ash-extension-' + [...id].map(char => char.codePointAt(0)!.toString(16)).join('-');
	const font = { id: family, src: await loadFontSource(fontPath, format, readResource) };
	return { icon: fontIconDefinition(font, character), font };
}

async function loadFontSource(path: unknown, format: string, readResource: (path: string) => Promise<Uint8Array>): Promise<string> {
	if (typeof path !== 'string') { throw new TypeError('Invalid icon font path'); }
	const relative = path.replace(/^\.\//u, '');
	if (!relative || relative.length > 1024 || /[\\:%?#\x00-\x1f]/u.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) { throw new TypeError('Icon fonts must stay inside the theme directory'); }
	const bytes = await readResource(relative);
	if (!bytes.length || bytes.length > 4_194_304) { throw new RangeError('Icon font resource must contain at most 4 MiB'); }
	let binary = '';
	for (let index = 0; index < bytes.length; index += 32768) { binary += String.fromCharCode(...bytes.subarray(index, index + 32768)); }
	return `url("data:application/octet-stream;base64,${btoa(binary)}") format("${format}")`;
}

function fontIconDefinition(font: IconFontDefinition, value: unknown): IconDefinition {
	if (typeof value !== 'string') { throw new TypeError('Invalid icon font character'); }
	const escaped = /^\\([\da-f]{1,6})$/iu.exec(value);
	const character = escaped ? Number.parseInt(escaped[1]!, 16) : [...value].length === 1 ? value.codePointAt(0)! : -1;
	if (character < 32 || character > 0x10ffff || character >= 0xd800 && character <= 0xdfff) { throw new TypeError('Invalid icon font character'); }
	return { fontCharacter: String.fromCodePoint(character), font: { id: font.id, definition: { weight: font.weight, style: font.style } } };
}
