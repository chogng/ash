import type { LanguageLink, LanguageLinkProvider, LanguageLinkRequest } from '../../../../../../editor/common/languages.js';
import { localize } from '../../../../../../nls.js';
import { PromptFileParser } from '../promptFileParser.js';

/** Links resolve relative to the exact resource; package access remains with the discovered Skill. */
export class PromptLinkProvider implements LanguageLinkProvider {
	private readonly parser = new PromptFileParser();

	public provideLinks(request: LanguageLinkRequest, signal: AbortSignal): readonly LanguageLink[] {
		if (signal.aborted || !request.resource || (!request.resource.path.endsWith('/SKILL.md') && request.resource.authority !== 'skill')) return [];
		const body = this.parser.parse(request.resource, request.snapshot.getText()).body;
		return body?.fileReferences.flatMap(reference => {
			const target = body.resolveFilePath(reference.content);
			return target ? [{ range: reference.range, target: target.toString(), tooltip: localize('prompt.references.open', 'Open referenced file') }] : [];
		}) ?? [];
	}
}
