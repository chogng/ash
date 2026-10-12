import { Range } from '../../../../../../editor/common/core/range.js';
import type { LanguageHover, LanguageHoverProvider, LanguageHoverRequest } from '../../../../../../editor/common/languages.js';
import { PromptFileParser } from '../promptFileParser.js';
import { getAttributeDefinition } from './promptFileAttributes.js';

export class PromptHoverProvider implements LanguageHoverProvider {
	private readonly parser = new PromptFileParser();

	public provideHover(request: LanguageHoverRequest, signal: AbortSignal): LanguageHover | undefined {
		if (signal.aborted || !request.resource?.path.endsWith('/SKILL.md')) return undefined;
		const source = request.snapshot.getText();
		const header = this.parser.parse(request.resource, source).header;
		if (!header?.range.containsPosition(request.position)) return undefined;
		const line = source.split(/\r\n|\n|\r/u)[request.position.lineNumber - 1]!;
		const match = /^([a-z][a-z-]*):/u.exec(line);
		if (!match || request.position.column > match[1]!.length + 1) return undefined;
		const definition = getAttributeDefinition(match[1]!);
		if (!definition) return undefined;
		return {
			range: new Range(request.position.lineNumber, 1, request.position.lineNumber, match[1]!.length + 1),
			contents: [definition.description],
		};
	}
}
