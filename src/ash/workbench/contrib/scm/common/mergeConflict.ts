export interface MergeConflictBlock {
	readonly start: number;
	readonly end: number;
	readonly current: string;
	readonly incoming: string;
	readonly base: string | undefined;
}

/** Parses Git's line-based conflict records without changing the surrounding result text. */
export function parseMergeConflictBlocks(text: string): readonly MergeConflictBlock[] {
	const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const blocks: MergeConflictBlock[] = [];
	let offset = 0;
	for (let index = 0; index < lines.length; index++) {
		const start = offset;
		const line = lines[index].replace(/\r?\n$/, '');
		offset += lines[index].length;
		if (!/^<{7}(?: |$)/.test(line)) continue;
		const currentStart = offset;
		let currentEnd = -1;
		let baseStart = -1;
		let baseEnd = -1;
		let incomingStart = -1;
		for (index++; index < lines.length; index++) {
			const marker = lines[index].replace(/\r?\n$/, '');
			const markerOffset = offset;
			offset += lines[index].length;
			if (/^\|{7}(?: |$)/.test(marker) && currentEnd < 0) {
				currentEnd = markerOffset;
				baseStart = offset;
			} else if (marker === '=======') {
				if (currentEnd < 0) currentEnd = markerOffset;
				if (baseStart >= 0) baseEnd = markerOffset;
				incomingStart = offset;
			} else if (/^>{7}(?: |$)/.test(marker) && incomingStart >= 0) {
				blocks.push({
					start,
					end: offset,
					current: text.slice(currentStart, currentEnd),
					incoming: text.slice(incomingStart, markerOffset),
					base: baseStart >= 0 ? text.slice(baseStart, baseEnd) : undefined,
				});
				break;
			}
		}
	}
	return blocks;
}

export function hasMergeConflictMarkers(text: string): boolean {
	return /^(?:<{7}(?:[ \r]|$)|\|{7}(?:[ \r]|$)|={7}\r?$|>{7}(?:[ \r]|$))/m.test(text);
}
