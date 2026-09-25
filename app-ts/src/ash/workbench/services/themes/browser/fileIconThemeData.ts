import type { FileIconDefinition, IWorkbenchFileIconTheme } from '../common/workbenchThemeService.js';
import { fileIconSelectorEscape, getIconClassesForLanguageId } from '../../../../editor/common/services/getIconClasses.js';

interface Associations {
	readonly file?: string;
	readonly folder?: string;
	readonly rootFolder?: string;
	readonly selectors: ReadonlyMap<string, string>;
}

/** Validates extension icon documents and resolves their package-relative resources. */
export class FileIconThemeData implements IWorkbenchFileIconTheme {
	private constructor(
		public readonly id: string,
		public readonly label: string,
		public readonly styleSheetContent: string,
		private readonly icons: ReadonlyMap<string, FileIconDefinition>,
		private readonly normal: Associations,
		private readonly light: Associations,
	) {}

	public static async load(id: string, label: string, value: unknown, readResource: (path: string) => Promise<Uint8Array>): Promise<FileIconThemeData> {
		const document = record(value);
		const fonts = new Map<string, { family: string; size: string }>();
		const styles: string[] = [];
		if (document.fonts !== undefined && !Array.isArray(document.fonts)) { throw new Error('Icon fonts must be an array'); }
		for (const [index, candidate] of ((document.fonts ?? []) as unknown[]).entries()) {
			const font = record(candidate);
			const fontId = text(font.id);
			if (fonts.has(fontId)) { throw new Error('Duplicate icon font'); }
			const family = 'ash-file-icon-' + Array.from(id).map(c => c.codePointAt(0)!.toString(16)).join('-') + '-' + index;
			if (!Array.isArray(font.src) || font.src.length === 0) { throw new Error('Icon font requires a source'); }
			const sources: string[] = [];
			for (const candidate of font.src) {
				const source = record(candidate);
				const format = text(source.format);
				if (!['woff', 'woff2', 'truetype', 'opentype'].includes(format)) { throw new Error('Unsupported icon font format'); }
				const data = dataUrl(await readResource(assetPath(source.path)), 'application/octet-stream');
				sources.push('url("' + data + '") format("' + format + '")');
			}
			const size = font.size === undefined ? '100%' : fontSize(font.size);
			fonts.set(fontId, { family, size });
			styles.push('@font-face{font-family:"' + family + '";src:' + sources.join(',') + ';font-display:block;}');
		}
		const icons = new Map<string, FileIconDefinition>();
		for (const [key, candidate] of Object.entries(record(document.iconDefinitions))) {
			const definition = record(candidate);
			const font = definition.fontId === undefined ? fonts.values().next().value : fonts.get(text(definition.fontId));
			let image = '';
			if (definition.iconPath !== undefined) {
				const path = assetPath(definition.iconPath);
				const extension = path.split('.').at(-1)?.toLowerCase();
				const mime = extension === 'svg' ? 'image/svg+xml' : extension === 'png' ? 'image/png' : undefined;
				if (!mime) { throw new Error('Unsupported icon image format'); }
				image = dataUrl(await readResource(path), mime);
			}
			const character = definition.fontCharacter === undefined ? '' : text(definition.fontCharacter);
			if (!image && character && !font) { throw new Error('Unknown icon font'); }
			const color = definition.fontColor === undefined ? '' : text(definition.fontColor);
			if (color && !/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) { throw new Error('Invalid icon color'); }
			const escape = /^\\([0-9a-f]{1,6})$/i.exec(character);
			icons.set(key, Object.freeze({
				character: escape ? String.fromCodePoint(parseInt(escape[1]!, 16)) : character,
				color, fontFamily: font?.family ?? '', fontSize: definition.fontSize === undefined ? font?.size ?? '100%' : fontSize(definition.fontSize), image,
			}));
		}
		const normal = associations(document, icons);
		const light = associations(document.light ?? {}, icons);
		styles.push(...suggestionStyles(icons, normal, light));
		return new FileIconThemeData(id, label, styles.join('\n'), icons, normal, light);
	}

	public resolveFileIcon(classes: readonly string[], dark: boolean): FileIconDefinition | undefined {
		const specific = (associations: Associations): string | undefined => {
			for (const className of classes) {
				const match = associations.selectors.get(className);
				if (match) return match;
			}
			return undefined;
		};
		const fallback = (associations: Associations): string | undefined =>
			classes.includes('rootfolder-icon') ? associations.rootFolder ?? associations.folder :
			classes.includes('folder-icon') ? associations.folder : associations.file;
		const icon = dark ? specific(this.normal) ?? fallback(this.normal) : specific(this.light) ?? specific(this.normal) ?? fallback(this.light) ?? fallback(this.normal);
		return icon === undefined ? undefined : this.icons.get(icon);
	}
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('Expected an icon theme object'); }
	return value as Record<string, unknown>;
}
function text(value: unknown): string {
	if (typeof value !== 'string' || !value || value.length > 1024) { throw new Error('Invalid icon theme text'); }
	return value;
}
function fontSize(value: unknown): string {
	const size = text(value);
	if (!/^(?:[1-9][0-9]{0,2})(?:\.[0-9]+)?%$/.test(size)) { throw new Error('Icon font size must be a percentage'); }
	return size;
}
function assetPath(value: unknown): string {
	const path = text(value).replace(/^\.\//, '');
	if (path.split('/').some(part => !part || part === '.' || part === '..') || /[\\:%?#\x00-\x1f]/.test(path)) { throw new Error('Icon asset must stay inside its theme directory'); }
	return path;
}
function dataUrl(bytes: Uint8Array, mime: string): string {
	let binary = '';
	for (let index = 0; index < bytes.length; index += 32768) { binary += String.fromCharCode(...bytes.subarray(index, index + 32768)); }
	return 'data:' + mime + ';base64,' + btoa(binary);
}
function associations(value: unknown, icons: ReadonlyMap<string, FileIconDefinition>): Associations {
	const input = record(value);
	const checked = (value: unknown): string => {
		const id = text(value);
		if (!icons.has(id)) { throw new Error('Unknown file icon definition: ' + id); }
		return id;
	};
	const selectors = new Map<string, string>();
	const add = (value: unknown, suffix: string): void => {
		for (const [name, icon] of Object.entries(record(value ?? {}))) {
			selectors.set(`${fileIconSelectorEscape(name.toLowerCase())}-${suffix}`, checked(icon));
		}
	};
	add(input.fileNames, 'name-file-icon');
	add(input.fileExtensions, 'ext-file-icon');
	add(input.folderNames, 'name-folder-icon');
	add(input.rootFolderNames, 'root-name-folder-icon');
	for (const [name, icon] of Object.entries(record(input.languageIds ?? {}))) {
		selectors.set(getIconClassesForLanguageId(name.toLowerCase())[1]!, checked(icon));
	}
	return {
		...(input.file === undefined ? {} : { file: checked(input.file) }),
		...(input.folder === undefined ? {} : { folder: checked(input.folder) }),
		...(input.rootFolder === undefined ? {} : { rootFolder: checked(input.rootFolder) }),
		selectors,
	};
}

function suggestionStyles(icons: ReadonlyMap<string, FileIconDefinition>, normal: Associations, light: Associations): string[] {
	const styles: string[] = [];
	const add = (selector: string, iconId: string | undefined): void => {
		if (!iconId) return;
		const icon = icons.get(iconId)!;
		styles.push(`${selector}{font-size:0;min-width:16px;inline-size:16px;}`);
		const common = 'display:inline-block;width:16px;height:16px;vertical-align:middle;';
		styles.push(icon.image
			? `${selector}::before{${common}content:"";background:url(${cssString(icon.image)}) center/contain no-repeat;}`
			: `${selector}::before{${common}content:${cssString(icon.character)};color:${icon.color || 'inherit'};font-family:${cssString(icon.fontFamily)};font-size:${icon.fontSize};line-height:16px;}`);
	};
	const base = ':where(.ash-workbench) .ash-themed-file-icon';
	const lightBase = ':where(.ash-workbench[data-color-scheme="light"],.ash-workbench[data-color-scheme="high-contrast-light"]) .ash-themed-file-icon';
	const defaults = (prefix: string, associations: Associations): void => {
		add(`${prefix}.file-icon`, associations.file);
		add(`${prefix}.folder-icon`, associations.folder);
		add(`${prefix}.rootfolder-icon`, associations.rootFolder ?? associations.folder);
	};
	const specifics = (prefix: string, associations: Associations): void => {
		const entries = [...associations.selectors].sort(([left], [right]) => iconSelectorPriority(left) - iconSelectorPriority(right) || left.length - right.length);
		for (const [className, iconId] of entries) {
			const kind = className.endsWith('-folder-icon') ? className.endsWith('-root-name-folder-icon') ? 'rootfolder-icon' : 'folder-icon' : 'file-icon';
			add(`${prefix}.${kind}[class~=${cssString(className)}]`, iconId);
		}
	};
	// The zero-specificity theme root lets a filename match outrank a light default;
	// light-specific matches then win over normal matches at the same specificity.
	defaults(base, normal);
	defaults(lightBase, light);
	specifics(base, normal);
	specifics(lightBase, light);
	return styles;
}

function iconSelectorPriority(className: string): number {
	if (className.endsWith('-lang-file-icon')) return 0;
	if (className.endsWith('-ext-file-icon')) return 1;
	return 2;
}

function cssString(value: string): string {
	return '"' + Array.from(value, character => /[a-z0-9_-]/i.test(character) ? character : `\\${character.codePointAt(0)!.toString(16)} `).join('') + '"';
}
