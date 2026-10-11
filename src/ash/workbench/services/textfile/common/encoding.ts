import { localize } from '../../../../nls.js';

/** File encodings offered by the editor, using codec identifiers at the byte boundary. */
export const SUPPORTED_ENCODINGS: Readonly<Record<string, { readonly labelShort: string }>> = Object.freeze(Object.fromEntries([
	['utf8', 'UTF-8'], ['utf8bom', 'UTF-8 with BOM'],
	['utf16le', 'UTF-16 LE'], ['utf16be', 'UTF-16 BE'],
	...Array.from({ length: 9 }, (_, index) => [`windows125${index}`, `Windows 125${index}`]),
	...Array.from({ length: 16 }, (_, index) => index + 1).filter(number => ![9, 11, 12].includes(number)).map(number => [`iso8859${number}`, `ISO 8859-${number}`]),
	['cp866', 'IBM 866'],
	['koi8r', 'KOI8-R'], ['koi8u', 'KOI8-U'],
	['gbk', 'GBK'], ['gb18030', 'GB18030'], ['big5', 'Big5'],
	['shiftjis', 'Shift JIS'], ['eucjp', 'EUC-JP'], ['euckr', 'EUC-KR'], ['windows874', 'Windows 874'],
].map(([id, labelShort]) => [id, Object.freeze({ labelShort })])));

export function getEncodingLabel(encoding: string): string {
	return encoding === 'utf8bom' ? localize('status.editor.utf8Bom', 'UTF-8 with BOM') : SUPPORTED_ENCODINGS[encoding]?.labelShort ?? encoding;
}

export function assertEncoding(encoding: unknown): asserts encoding is string {
	if (typeof encoding !== 'string' || !Object.hasOwn(SUPPORTED_ENCODINGS, encoding)) {
		throw new RangeError(localize('files.unsupportedEncoding', 'Unsupported file encoding: {0}', String(encoding)));
	}
}

