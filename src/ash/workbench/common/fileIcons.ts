import type { Icon } from '../../base/common/icon.js';
import { Lxicon } from '../../base/common/lxicons.js';

export const builtinFileIcons: ReadonlyMap<string, Icon> = new Map([
	['csv', Lxicon.csvGreen],
	['doc', Lxicon.docxBlue],
	['docx', Lxicon.docxBlue],
	['pdf', Lxicon.pdfRed],
	['xls', Lxicon.xlsGreen],
	['xlsx', Lxicon.xlsGreen],
]);

export function getBuiltinFileIcon(name: string): Icon {
	const dot = name.lastIndexOf('.');
	if (dot < 0) return Lxicon.file;
	return builtinFileIcons.get(name.slice(dot + 1).toLowerCase()) ?? Lxicon.file;
}
