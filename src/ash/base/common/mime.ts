import { extname } from './path.js';

export const Mimes = Object.freeze({
	text: 'text/plain',
	binary: 'application/octet-stream',
	unknown: 'application/unknown',
	markdown: 'text/markdown',
	latex: 'text/latex',
	uriList: 'text/uri-list',
	html: 'text/html',
});

const textExtensions: Readonly<Record<string, readonly string[]>> = {
	[Mimes.text]: ['.txt'],
	[Mimes.html]: ['.html', '.htm'],
	[Mimes.markdown]: ['.md', '.markdown'],
	[Mimes.latex]: ['.tex'],
	'text/css': ['.css'],
	'text/csv': ['.csv'],
	'text/javascript': ['.js', '.mjs'],
	'application/json': ['.json'],
	'application/xml': ['.xml'],
};

const mediaExtensions: Readonly<Record<string, readonly string[]>> = {
	'image/avif': ['.avif'],
	'image/bmp': ['.bmp'],
	'image/gif': ['.gif'],
	'image/x-icon': ['.ico'],
	'image/jpeg': ['.jpg', '.jpeg', '.jpe'],
	'image/png': ['.png'],
	'image/svg+xml': ['.svg'],
	'image/tiff': ['.tif', '.tiff'],
	'image/webp': ['.webp'],
	'audio/aac': ['.aac'],
	'audio/flac': ['.flac'],
	'audio/mpeg': ['.mp3'],
	'audio/mp4': ['.m4a'],
	'audio/ogg': ['.ogg', '.oga'],
	'audio/wav': ['.wav'],
	'video/mp4': ['.mp4', '.m4v'],
	'video/mpeg': ['.mpeg', '.mpg'],
	'video/ogg': ['.ogv'],
	'video/quicktime': ['.mov'],
	'video/webm': ['.webm'],
	'font/otf': ['.otf'],
	'font/ttf': ['.ttf'],
	'font/woff': ['.woff'],
	'font/woff2': ['.woff2'],
	'application/pdf': ['.pdf'],
	'application/wasm': ['.wasm'],
	'application/zip': ['.zip'],
	[Mimes.binary]: ['.bin'],
};

export function getMediaOrTextMime(path: string): string | undefined {
	const extension = extname(path).toLowerCase();
	for (const [mime, extensions] of Object.entries(textExtensions)) {
		if (extensions.includes(extension)) {
			return mime;
		}
	}
	return getMediaMime(path);
}

export function getMediaMime(path: string): string | undefined {
	const extension = extname(path).toLowerCase();
	for (const [mime, extensions] of Object.entries(mediaExtensions)) {
		if (extensions.includes(extension)) {
			return mime;
		}
	}
	return undefined;
}

export function getExtensionForMimeType(mimeType: string): string | undefined {
	const type = normalizeMimeType(mimeType).split(';', 1)[0]!;
	const canonicalType = type === 'image/jpg' ? 'image/jpeg' : type;
	return textExtensions[canonicalType]?.[0] ?? mediaExtensions[canonicalType]?.[0];
}

const mimePattern = /^([^/\s]+)\/([^;\s]+)(;.*)?$/u;

export function normalizeMimeType(value: string): string;
export function normalizeMimeType(value: string, strict: true): string | undefined;
export function normalizeMimeType(value: string, strict?: true): string | undefined {
	const match = mimePattern.exec(value);
	if (!match) return strict ? undefined : value;
	return `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}${match[3] ?? ''}`;
}

export function isTextStreamMime(value: string): boolean {
	return value === 'application/vnd.code.notebook.stdout' || value === 'application/vnd.code.notebook.stderr';
}
