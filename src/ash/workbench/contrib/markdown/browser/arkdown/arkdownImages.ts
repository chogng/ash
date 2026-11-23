import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { localize } from '../../../../../nls.js';

export interface ArkdownImageSource { readonly source: string; readonly description: string; readonly title?: string; }
export interface ArkdownImageLayout { readonly width?: number; readonly alignment: 'left' | 'center' | 'right'; }
const maxDocsImageBytes = 8 * 1024 * 1024;
const embeddedImage = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/u;

/** The same source allowlist applies to imported bytes and untrusted Markdown. */
export function isArkdownImageSource(source: string): boolean {
	if (/^data:/iu.test(source)) return source.length <= Math.ceil(maxDocsImageBytes * 4 / 3) + 64 && embeddedImage.test(source) && (source.length - source.indexOf(',') - 1) % 4 === 0;
	try { const url = new URL(source); return !/[\p{Cc}]/u.test(source) && (url.protocol === 'http:' || url.protocol === 'https:'); }
	catch { return false; }
}

export function checkDocsImageSize(size: number): void {
	if (size > maxDocsImageBytes) throw new Error(localize({ bundle: 'ash.docs', key: 'imageTooLarge' }, 'Choose an image smaller than 8 MB.'));
}

export async function readArkdownImage(bytes: Uint8Array, name: string): Promise<ArkdownImageSource> {
	checkDocsImageSize(bytes.byteLength);
	const prefix = String.fromCharCode(...bytes.subarray(0, 12));
	const type = prefix.startsWith('\x89PNG\r\n\x1a\n') ? 'image/png'
		: bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg'
			: /^GIF8[79]a/u.test(prefix) ? 'image/gif'
				: prefix.startsWith('RIFF') && prefix.slice(8) === 'WEBP' ? 'image/webp' : undefined;
	if (!type) throw new Error(localize({ bundle: 'ash.docs', key: 'unsupportedImage' }, 'Choose a PNG, JPEG, GIF or WebP image.'));
	try {
		const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type }));
		try { if (bitmap.width > 16384 || bitmap.height > 16384 || bitmap.width * bitmap.height > 64 * 1024 * 1024) throw new Error(); }
		finally { bitmap.close(); }
	} catch { throw new Error(localize({ bundle: 'ash.docs', key: 'invalidImage' }, 'The image could not be read.')); }
	return { source: `data:${type};base64,${encodeBase64(VSBuffer.wrap(new Uint8Array(bytes)))}`, description: name.replace(/\.[^.]+$/u, '') };
}

export async function readArkdownImageFile(file: File): Promise<ArkdownImageSource> {
	checkDocsImageSize(file.size);
	return readArkdownImage(new Uint8Array(await file.arrayBuffer()), file.name);
}

/** Layout uses a reserved GFM title, so Markdown export and shared undo retain
 * it without enabling arbitrary HTML. Ordinary image titles round-trip inside it. */
export function writeArkdownImage(image: ArkdownImageSource, layout?: ArkdownImageLayout): string {
	const description = image.description.replace(/[\\\[\]]/gu, '\\$&').replace(/[\r\n]/gu, ' ');
	const metadata = layout && (layout.width !== undefined || layout.alignment !== 'left') ? `ash-image:${JSON.stringify({ ...layout, ...(image.title ? { title: image.title } : {}) })}` : image.title ?? '';
	const title = metadata.replace(/[\\"]/gu, '\\$&').replace(/[\r\n]/gu, ' ');
	return `![${description}](<${image.source.replace(/[<>]/gu, value => encodeURIComponent(value))}>${title ? ` "${title}"` : ''})`;
}

export function readArkdownImageLayout(title: string | undefined): ArkdownImageLayout & { readonly title?: string; } {
	if (title?.startsWith('ash-image:') && title.length < 4096) {
		try {
			const value: unknown = JSON.parse(title.slice(10));
			if (value && typeof value === 'object' && 'alignment' in value && ['left', 'center', 'right'].includes(String(value.alignment)) && (!('width' in value) || typeof value.width === 'number' && Number.isInteger(value.width) && value.width >= 40 && value.width <= 16384) && (!('title' in value) || typeof value.title === 'string')) return { alignment: value.alignment as ArkdownImageLayout['alignment'], ...('width' in value ? { width: value.width as number } : {}), ...('title' in value ? { title: value.title as string } : {}) };
		} catch { /* Ordinary titles, including invalid reserved text, remain user content. */ }
	}
	return { alignment: 'left', title };
}
