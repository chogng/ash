import type { URI } from '../../../base/common/uri.js';

const contentTypes: Readonly<Record<string, string>> = {
	'.avif': 'image/avif',
	'.bmp': 'image/bmp',
	'.css': 'text/css',
	'.gif': 'image/gif',
	'.html': 'text/html',
	'.ico': 'image/x-icon',
	'.jpeg': 'image/jpeg',
	'.jpg': 'image/jpeg',
	'.js': 'text/javascript',
	'.json': 'application/json',
	'.mjs': 'text/javascript',
	'.mp3': 'audio/mpeg',
	'.mp4': 'video/mp4',
	'.ogg': 'audio/ogg',
	'.otf': 'font/otf',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.ttf': 'font/ttf',
	'.txt': 'text/plain',
	'.wasm': 'application/wasm',
	'.wav': 'audio/wav',
	'.webm': 'video/webm',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
};

export function getWebviewContentMimeType(resource: URI): string {
	const filename = resource.path.slice(resource.path.lastIndexOf('/') + 1);
	const dot = filename.lastIndexOf('.');
	return (dot < 0 ? undefined : contentTypes[filename.slice(dot).toLowerCase()]) ?? 'application/octet-stream';
}
