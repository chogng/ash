import type { IconFontDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import type { IconDefinition } from '../../../../base/common/icon.js';
import type { IWorkbenchProductIconTheme } from '../common/workbenchThemeService.js';

const iconIdPattern = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u;
const allowedElements = new Set(['svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
const allowedAttributes = new Set([
	'xmlns', 'viewBox', 'width', 'height', 'preserveAspectRatio', 'fill', 'stroke', 'stroke-width',
	'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'fill-rule',
	'clip-rule', 'opacity', 'fill-opacity', 'stroke-opacity', 'd', 'cx', 'cy', 'r', 'rx', 'ry',
	'x', 'y', 'x1', 'x2', 'y1', 'y2', 'points', 'transform',
]);

/** Loads the SVG artwork referenced by an extension product icon theme. */
export class ProductIconThemeData {
	public static async load(id: string, label: string, source: unknown, readResource: (path: string) => Promise<Uint8Array>, document: Document): Promise<IWorkbenchProductIconTheme> {
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
			if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`Product icon '${iconId}' must declare iconPath`);
			const definition = value as Record<string, unknown>;
			if (definition.fontCharacter !== undefined) {
				if (definition.iconPath !== undefined) { throw new TypeError('Product icons require one artwork source'); }
				const fontId = definition.fontId === undefined ? fontIds.keys().next().value : definition.fontId;
				const family = typeof fontId === 'string' ? fontIds.get(fontId) : undefined;
				if (!family) { throw new TypeError('Unknown product icon font'); }
				icons.set(iconId, fontIconDefinition(family, definition.fontCharacter));
				continue;
			}
			const iconPath = definition.iconPath;
			if (typeof iconPath !== 'string') throw new TypeError(`Product icon '${iconId}' must declare iconPath`);
			const path = iconPath.startsWith('./') ? iconPath.slice(2) : iconPath;
			if (path.length === 0 || path.length > 1024 || !path.endsWith('.svg') || path.includes('\\') || path.startsWith('/') || path.includes(':') || path.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
				throw new TypeError(`Product icon '${iconId}' has an invalid iconPath`);
			}
			const bytes = await readResource(path);
			if (bytes.byteLength > 131_072) throw new RangeError(`Product icon '${iconId}' SVG is too large`);
			const svg = validateSvg(new TextDecoder('utf-8', { fatal: true }).decode(bytes), iconId, document);
			icons.set(iconId, () => svg);
		}
		return Object.freeze({ id, label, icons, fonts });
	}
}

function validateSvg(source: string, iconId: string, document: Document): string {
	const parsed = new document.defaultView!.DOMParser().parseFromString(source, 'image/svg+xml');
	const root = parsed.documentElement;
	if (root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg' || parsed.getElementsByTagName('parsererror').length !== 0 || !root.hasAttribute('viewBox')) {
		throw new TypeError(`Product icon '${iconId}' must contain one valid SVG with a viewBox`);
	}
	const visit = (element: Element): void => {
		if (!allowedElements.has(element.localName) || element.namespaceURI !== 'http://www.w3.org/2000/svg') throw new TypeError(`Product icon '${iconId}' contains unsupported SVG content`);
		for (const attribute of [...element.attributes]) {
			if (!allowedAttributes.has(attribute.name) || /url\s*\(|[<>]/iu.test(attribute.value)) throw new TypeError(`Product icon '${iconId}' contains an unsupported SVG attribute`);
		}
		for (const child of [...element.childNodes]) {
			if (child.nodeType === 1) visit(child as Element);
			else if (child.nodeType === 3 && child.textContent?.trim()) throw new TypeError(`Product icon '${iconId}' contains text`);
			else if (child.nodeType !== 3 && child.nodeType !== 8) throw new TypeError(`Product icon '${iconId}' contains unsupported SVG content`);
		}
	};
	visit(root);
	return new document.defaultView!.XMLSerializer().serializeToString(root);
}

/** Extension icon defaults use the same verified font resources and artwork as product icon themes. */
export async function loadExtensionFontIcon(id: string, fontPath: string, character: string, readResource: (path: string) => Promise<Uint8Array>): Promise<{ readonly icon: IconDefinition; readonly font: IconFontDefinition }> {
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
	// An SVG text node keeps the existing icon DOM and accessibility contract while using a font glyph.
	return () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><text x="0" y="14" font-family="${font.id}" font-size="16" font-weight="${font.weight ?? 'normal'}" font-style="${font.style ?? 'normal'}" fill="currentColor">&#${character};</text></svg>`;
}
