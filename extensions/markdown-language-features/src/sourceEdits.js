/** Textareas normalize line endings. Map input positions back to the original
 * source so untouched whitespace, escapes and delimiters remain exact. */
export function sourceOffset(source, position) {
	let offset = 0;
	for (let index = 0; index < position; index++, offset++) {
		if (source[offset] === '\r' && source[offset + 1] === '\n') offset++;
	}
	return offset;
}

export function inputEdit(source, value) {
	const normalized = source.replace(/\r\n?/gu, '\n');
	let start = 0;
	while (start < normalized.length && start < value.length && normalized[start] === value[start]) start++;
	let end = normalized.length;
	let nextEnd = value.length;
	while (end > start && nextEnd > start && normalized[end - 1] === value[nextEnd - 1]) {
		end--;
		nextEnd--;
	}
	if (start > 0 && /[\uDC00-\uDFFF]/u.test(normalized[start] ?? value[start] ?? '')) start--;
	if (end < normalized.length && /[\uDC00-\uDFFF]/u.test(normalized[end])) {
		end++;
		nextEnd++;
	}
	return {
		start: sourceOffset(source, start),
		end: sourceOffset(source, end),
		text: value.slice(start, nextEnd).replaceAll('\n', source.includes('\r\n') ? '\r\n' : '\n'),
	};
}

export function normalizedOffset(source, offset) {
	return source.slice(0, offset).replace(/\r\n?/gu, '\n').length;
}

/** Minimal UTF-16 edit between exact source snapshots, preserving line endings. */
export function textEdit(previous, next) {
	let start = 0;
	while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
	let end = previous.length;
	let nextEnd = next.length;
	while (end > start && nextEnd > start && previous[end - 1] === next[nextEnd - 1]) {
		end--;
		nextEnd--;
	}
	if (start > 0 && /[\uDC00-\uDFFF]/u.test(previous[start] ?? next[start] ?? '')) start--;
	if (end < previous.length && /[\uDC00-\uDFFF]/u.test(previous[end])) {
		end++;
		nextEnd++;
	}
	return { start, end, text: next.slice(start, nextEnd) };
}
