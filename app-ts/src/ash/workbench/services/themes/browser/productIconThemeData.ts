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
		const definitions = (source as Record<string, unknown>).iconDefinitions;
		if (typeof definitions !== 'object' || definitions === null || Array.isArray(definitions)) throw new TypeError(`Product icon theme '${id}' requires iconDefinitions`);
		const entries = Object.entries(definitions);
		if (entries.length > 512) throw new RangeError(`Product icon theme '${id}' has too many icons`);
		const icons = new Map<string, IconDefinition>();
		for (const [iconId, value] of entries) {
			if (!iconIdPattern.test(iconId)) throw new TypeError(`Invalid product icon ID '${iconId}'`);
			if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`Product icon '${iconId}' must declare iconPath`);
			const iconPath = (value as Record<string, unknown>).iconPath;
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
		return Object.freeze({ id, label, icons });
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
