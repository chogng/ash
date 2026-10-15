const elements = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'li', 'pre', 'table', 'thead', 'tr', 'td', 'em', 'strong', 'del']);

/** The command result is an external boundary, including when its provider is preinstalled. */
export function readParseResponse(response, snapshot) {
	if (response?.protocol_version !== 1 || response.uri !== snapshot.uri || response.version !== snapshot.version || !Array.isArray(response.blocks) || !response.blocks.length) throw new TypeError('Invalid Markdown parse response');
	let count = 0;
	function node(value, depth = 0) {
		if (!value || typeof value !== 'object' || depth > 128 || ++count > 1000000) throw new TypeError('Invalid Markdown node');
		switch (value.kind) {
			case 'text': case 'raw': case 'code':
				if (typeof value.value !== 'string') throw new TypeError('Invalid Markdown text');
				return;
			case 'math':
				if (typeof value.value !== 'string' || typeof value.display !== 'boolean') throw new TypeError('Invalid Markdown math');
				return;
			case 'task':
				if (typeof value.checked !== 'boolean' || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset + 3 > snapshot.text.length) throw new TypeError('Invalid Markdown task');
				return;
			case 'break': case 'rule': return;
			case 'element':
				if (!elements.has(value.tag)) throw new TypeError('Invalid Markdown element');
				break;
			case 'ordered_list':
				if (!Number.isSafeInteger(value.first) || value.first < 0) throw new TypeError('Invalid Markdown list');
				break;
			case 'link': case 'image':
				if (typeof value.destination !== 'string') throw new TypeError('Invalid Markdown destination');
				break;
			default: throw new TypeError('Unknown Markdown node');
		}
		if (!Array.isArray(value.children)) throw new TypeError('Invalid Markdown children');
		for (const child of value.children) node(child, depth + 1);
	}
	let offset = 0;
	for (const block of response.blocks) {
		if (!block || block.start !== offset || !Number.isSafeInteger(block.end) || block.end < offset || block.end > snapshot.text.length) throw new TypeError('Invalid Markdown source ranges');
		node(block.content);
		offset = block.end;
	}
	if (offset !== snapshot.text.length) throw new TypeError('Incomplete Markdown source ranges');
	return response.blocks;
}
