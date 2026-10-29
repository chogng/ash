import { localize } from '../../../../nls.js';

/** File encodings offered by the editor, using codec identifiers at the byte boundary. */
export const SUPPORTED_ENCODINGS: Readonly<Record<string, { readonly labelShort: string; readonly encodeOnly?: boolean; readonly hidden?: boolean; }>> = Object.freeze(Object.fromEntries([
	['utf8', 'UTF-8'], ['utf8bom', 'UTF-8 with BOM'], ['utf16le', 'UTF-16 LE'],
	['utf16be', 'UTF-16 BE'], ['windows1252', 'Windows 1252'], ['iso88591', 'ISO 8859-1'],
	['iso88593', 'ISO 8859-3'], ['iso885915', 'ISO 8859-15'], ['macroman', 'Mac Roman'],
	['cp437', 'CP437'], ['windows1256', 'Windows 1256'], ['iso88596', 'ISO 8859-6'],
	['windows1257', 'Windows 1257'], ['iso88594', 'ISO 8859-4'], ['iso885914', 'ISO 8859-14'],
	['windows1250', 'Windows 1250'], ['iso88592', 'ISO 8859-2'], ['cp852', 'CP 852'],
	['windows1251', 'Windows 1251'], ['cp866', 'CP 866'], ['cp1125', 'CP 1125'],
	['iso88595', 'ISO 8859-5'], ['koi8r', 'KOI8-R'], ['koi8u', 'KOI8-U'],
	['iso885913', 'ISO 8859-13'], ['windows1253', 'Windows 1253'], ['iso88597', 'ISO 8859-7'],
	['windows1255', 'Windows 1255'], ['iso88598', 'ISO 8859-8'], ['iso885910', 'ISO 8859-10'],
	['iso885916', 'ISO 8859-16'], ['windows1254', 'Windows 1254'], ['iso88599', 'ISO 8859-9'],
	['cp857', 'CP 857'], ['windows1258', 'Windows 1258'], ['gbk', 'GBK'],
	['gb18030', 'GB18030'], ['cp950', 'Big5'], ['big5hkscs', 'Big5-HKSCS'],
	['shiftjis', 'Shift JIS'], ['eucjp', 'EUC-JP'], ['euckr', 'EUC-KR'],
	['windows874', 'Windows 874'], ['iso885911', 'ISO 8859-11'], ['koi8ru', 'KOI8-RU'],
	['koi8t', 'KOI8-T'], ['gb2312', 'GB 2312'], ['cp865', 'CP 865'],
	['cp850', 'CP 850'],
	// Preserve files opened with Ash's original Big5 identifier without a duplicate picker row.
	['big5', 'Big5'],
].map(([id, labelShort]) => [id, Object.freeze({ labelShort, ...(id === 'utf8bom' ? { encodeOnly: true } : {}), ...(id === 'big5' ? { hidden: true } : {}) })])));

const guessableIds = ['utf8', 'utf16le', 'utf16be', 'windows1252', 'windows1250', 'iso88592', 'windows1251', 'cp866', 'cp1125', 'iso88595', 'koi8r', 'windows1253', 'iso88597', 'windows1255', 'iso88598', 'cp950', 'shiftjis', 'eucjp', 'euckr', 'gb2312'];
export const GUESSABLE_ENCODINGS = Object.freeze(Object.fromEntries(guessableIds.map(id => [id, SUPPORTED_ENCODINGS[id]])));

export function getEncodingLabel(encoding: string): string {
	return encoding === 'utf8bom' ? localize('status.editor.utf8Bom', 'UTF-8 with BOM') : SUPPORTED_ENCODINGS[encoding]?.labelShort ?? encoding;
}

export function assertEncoding(encoding: unknown): asserts encoding is string {
	if (typeof encoding !== 'string' || !Object.hasOwn(SUPPORTED_ENCODINGS, encoding)) {
		throw new RangeError(localize('files.unsupportedEncoding', 'Unsupported file encoding: {0}', String(encoding)));
	}
}
