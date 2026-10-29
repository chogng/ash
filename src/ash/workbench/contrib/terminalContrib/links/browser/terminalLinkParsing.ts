import { OperatingSystem } from '../../../../../base/common/platform.js';

export interface ILinkPartialRange {
	index: number;
	text: string;
}

export interface ILinkSuffix {
	row: number | undefined;
	col: number | undefined;
	rowEnd: number | undefined;
	colEnd: number | undefined;
	suffix: ILinkPartialRange;
}

export interface IParsedLink {
	path: ILinkPartialRange;
	prefix?: ILinkPartialRange;
	suffix?: ILinkSuffix;
}

/** Extracts candidates only. The file service still decides whether each path exists. */
export function detectLinks(line: string, os: OperatingSystem): IParsedLink[] {
	if (line.length > 8192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(line)) return [];
	const links: IParsedLink[] = [];
	const occupied: { start: number; end: number }[] = [];
	const add = (text: string, index: number, end = index + text.length): void => {
		if (occupied.some(range => index < range.end && end > range.start)) return;
		const candidate = parseCandidate(text, index, os);
		if (!candidate) return;
		links.push(candidate);
		occupied.push({ start: index, end });
	};

	// Quotes and stack-frame parentheses delimit paths containing spaces.
	for (const match of line.matchAll(/(["'`])([^"'`\r\n]+)\1/g)) {
		const index = match.index + 1;
		const following = line.slice(match.index + match[0].length);
		const location =
			/^(?:,?\s+line\s+\d+(?:,?\s+(?:col(?:umn)?|character)\s+\d+)?|:\d+(?::\d+)?)/u.exec(following)?.[0] ?? '';
		if (location) {
			const candidate = parseCandidate(match[2] + location, index, os);
			if (candidate?.suffix) {
				candidate.suffix.suffix.index++;
				links.push(candidate);
				occupied.push({ start: match.index, end: match.index + match[0].length + location.length });
			}
		} else {
			add(match[2], index, match.index + match[0].length);
		}
	}
	for (const match of line.matchAll(/\(([^()\r\n]*[\/\\][^()\r\n]*:\d+(?::\d+)?)\)/g)) {
		add(match[1], match.index + 1);
	}
	// Compiler diagnostics often put an unquoted absolute path at the start.
	const diagnostic =
		/^\s*((?:\/|[A-Za-z]:[\\/]|\.{1,2}\/)[^\r\n]+?(?::\d+(?::\d+)?|\(\d+,?\s*\d*\)))(?=\s|:|$)/u.exec(line);
	if (diagnostic) add(diagnostic[1], diagnostic.index + diagnostic[0].indexOf(diagnostic[1]));
	for (const match of line.matchAll(/[^\s"'`<>{}\[\]]+/g)) {
		const text = match[0].replace(/^[(&]+/u, '').replace(/[;,.]+$/u, '');
		const index = match.index + match[0].indexOf(text);
		add(text, index);
	}
	return links.sort((a, b) => a.path.index - b.path.index);
}

function parseCandidate(text: string, index: number, os: OperatingSystem): IParsedLink | undefined {
	if (text.length > 4096 || (/^[a-z][a-z\d+.-]*:\/\//iu.test(text) && !text.startsWith('file://'))) return undefined;
	const location =
		/(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\)|,?\s+line\s+(\d+)(?:,?\s+(?:col(?:umn)?|character)\s+(\d+))?)(?::|\))?$/u.exec(
			text,
		);
	const path = location ? text.slice(0, location.index) : text.replace(/[):]+$/u, '');
	if (!path || /^(?:https?|data|command):/iu.test(path)) return undefined;
	const hasSeparator = path.includes('/') || (os === OperatingSystem.Windows && path.includes('\\'));
	if (!hasSeparator && !/\.[\p{L}\p{N}_-]+$/u.test(path) && !location) return undefined;
	if (!location) return { path: { index, text: path } };
	const row = Number(location[1] ?? location[3] ?? location[5]);
	const colText = location[2] ?? location[4] ?? location[6];
	const col = colText === undefined ? undefined : Number(colText);
	if (![row, col ?? 1].every(value => Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff))
		return undefined;
	return {
		path: { index, text: path },
		suffix: {
			row,
			col,
			rowEnd: undefined,
			colEnd: undefined,
			suffix: { index: index + location.index, text: location[0] },
		},
	};
}
