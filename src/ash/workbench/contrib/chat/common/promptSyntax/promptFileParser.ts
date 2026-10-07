import type { URI } from '../../../../../base/common/uri.js';

/** Keeps the exact document and separates its Markdown body for readonly snapshot consumers. */
export class ParsedPromptFile {
	constructor(public readonly uri: URI, public readonly content: string, public readonly body: string) { }
}

export class PromptFileParser {
	public parse(uri: URI, content: string): ParsedPromptFile {
		const lines = content.split(/\r?\n/u);
		if (lines[0] !== '---') return new ParsedPromptFile(uri, content, content);
		const end = lines.findIndex((line, index) => index > 0 && line === '---');
		// Syntax tooling for editable YAML headers is separate from backend manifest validation.
		return new ParsedPromptFile(uri, content, end < 0 ? content : lines.slice(end + 1).join('\n'));
	}
}
