import type { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';

/** Keeps the exact document and separates its Markdown body for readonly snapshot consumers. */
export class ParsedPromptFile {
	constructor(
		public readonly uri: URI,
		public readonly content: string,
		public readonly header?: PromptHeader,
		public readonly body?: PromptBody,
	) { }
}

/** Syntax coordinates only; the Rust catalog remains the authority for Skill metadata and validity. */
export class PromptHeader {
	constructor(public readonly range: Range, public readonly uri: URI) { }
}

/** Keeps body offsets in the exact source while exposing editor line/column coordinates. */
export class PromptBody {
	constructor(
		public readonly range: Range,
		private readonly source: string,
		public readonly uri: URI,
		public readonly offset: number,
	) { }

	public getContent(): string {
		return this.source.slice(this.offset);
	}
}

export class PromptFileParser {
	public parse(uri: URI, content: string): ParsedPromptFile {
		const lines = content.split(/(\r\n|\n|\r)/u);
		let bodyOffset = 0;
		let bodyLine = 1;
		let header: PromptHeader | undefined;
		if (lines[0] === '---') {
			header = new PromptHeader(new Range(2, 1, Math.max(2, Math.floor(lines.length / 2) + 1), lines.at(-1)!.length + 1), uri);
			let offset = lines[0].length + (lines[1]?.length ?? 0);
			for (let index = 2; index < lines.length; index += 2) {
				offset += lines[index]!.length + (lines[index + 1]?.length ?? 0);
				if (lines[index] === '---') {
					bodyOffset = offset;
					bodyLine = index / 2 + 2;
					header = new PromptHeader(new Range(2, 1, index / 2 + 1, 1), uri);
					break;
				}
			}
		}
		const body = bodyOffset < content.length
			? new PromptBody(new Range(bodyLine, 1, Math.floor(lines.length / 2) + 1, lines.at(-1)!.length + 1), content, uri, bodyOffset)
			: undefined;
		return new ParsedPromptFile(uri, content, header, body);
	}
}
