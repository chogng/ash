import type { LanguageHover, LanguageHoverProvider, LanguageHoverRequest } from '../../../../../../editor/common/languages.js';
import { PromptValidator } from './promptValidator.js';
import { PromptFileParser } from '../promptFileParser.js';
import { getAttributeDefinition } from './promptFileAttributes.js';
import { getPromptFileType } from '../promptTypes.js';

export class PromptHoverProvider implements LanguageHoverProvider {
	private readonly parser = new PromptFileParser();
	private readonly validator = new PromptValidator();

	public provideHover(request: LanguageHoverRequest, signal: AbortSignal): LanguageHover | undefined {
		const type = request.resource && getPromptFileType(request.resource);
		if (signal.aborted || !request.resource || !type) { return undefined; }
		const source = request.snapshot.getText();
		const parsed = this.parser.parse(request.resource, source);
		const header = parsed.header;
		if (!header?.range.containsPosition(request.position)) return undefined;
		const attribute = header.attributes.find(attribute => attribute.range.startLineNumber === request.position.lineNumber && attribute.range.containsPosition(request.position));
		const keyRange = attribute?.keyRange;
		const definition = attribute && keyRange?.containsPosition(request.position) ? getAttributeDefinition(attribute.key, type) : undefined;
		const diagnostic = this.validator.validate(parsed).find(diagnostic => diagnostic.code !== 'requiredField' && diagnostic.range.containsPosition(request.position));
		if (!definition && !diagnostic) return undefined;
		return {
			range: diagnostic?.range ?? keyRange!,
			contents: [...(diagnostic ? [diagnostic.message] : []), ...(definition ? [definition.description] : [])],
		};
	}
}
