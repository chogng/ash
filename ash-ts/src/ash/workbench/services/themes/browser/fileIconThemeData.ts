import type { FileIconDefinition, IWorkbenchFileIconTheme } from '../common/workbenchThemeService.js';

interface Associations {
	readonly file?: string;
	readonly fileNames: Readonly<Record<string, string>>;
	readonly fileExtensions: Readonly<Record<string, string>>;
	readonly languageIds: Readonly<Record<string, string>>;
}

const LANGUAGE_ID_BY_EXTENSION = new Map<string, string>([
	["bash", "shellscript"],
	["cc", "cpp"],
	["cjs", "javascript"],
	["clj", "clojure"],
	["cljs", "clojure"],
	["coffee", "coffeescript"],
	["cs", "csharp"],
	["cxx", "cpp"],
	["fs", "fsharp"],
	["fsx", "fsharp"],
	["h", "c"],
	["hh", "cpp"],
	["hpp", "cpp"],
	["hs", "haskell"],
	["js", "javascript"],
	["jsx", "javascriptreact"],
	["kt", "kotlin"],
	["kts", "kotlin"],
	["md", "markdown"],
	["mjs", "javascript"],
	["pl", "perl"],
	["pm", "perl"],
	["ps1", "powershell"],
	["py", "python"],
	["rb", "ruby"],
	["rs", "rust"],
	["sh", "shellscript"],
	["ts", "typescript"],
	["tsx", "typescriptreact"],
	["yml", "yaml"],
	["zsh", "shellscript"],
]);


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
		return new FileIconThemeData(id, label, styles.join('\n'), icons, associations(document, icons), associations(document.light ?? {}, icons));
	}

	public resolveFileIcon(name: string, dark: boolean): FileIconDefinition | undefined {
		const normalized = name.toLowerCase();
		const specific = (associations: Associations): string | undefined => {
			if (associations.fileNames[normalized]) { return associations.fileNames[normalized]; }
			const segments = normalized.split('.');
			for (let index = 1; index < segments.length; index++) {
				const match = associations.fileExtensions[segments.slice(index).join('.')];
				if (match) { return match; }
			}
			const extension = segments.at(-1)!;
			return associations.languageIds[LANGUAGE_ID_BY_EXTENSION.get(extension) ?? extension];
		};
		const icon = dark ? specific(this.normal) ?? this.normal.file : specific(this.light) ?? specific(this.normal) ?? this.light.file ?? this.normal.file;
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
	const map = (value: unknown): Readonly<Record<string, string>> => Object.freeze(Object.fromEntries(Object.entries(record(value ?? {})).map(([name, icon]) => [name.toLowerCase(), checked(icon)])));
	return Object.freeze({ ...(input.file === undefined ? {} : { file: checked(input.file) }), fileNames: map(input.fileNames), fileExtensions: map(input.fileExtensions), languageIds: map(input.languageIds) });
}
