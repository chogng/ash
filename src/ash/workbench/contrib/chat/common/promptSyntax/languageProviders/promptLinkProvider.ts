import type { LanguageLink, LanguageLinkProvider, LanguageLinkRequest } from '../../../../../../editor/common/languages.js';
import { localize } from '../../../../../../nls.js';
import { IPathService } from '../../../../../../platform/path/common/pathService.js';
import { PromptFileParser } from '../promptFileParser.js';
import { getPromptFileType } from '../promptTypes.js';

/** Links resolve relative to the exact resource; package access remains with the discovered Skill. */
export class PromptLinkProvider implements LanguageLinkProvider {
	private readonly parser = new PromptFileParser();

	constructor(@IPathService private readonly paths: IPathService) { }

	public provideLinks(request: LanguageLinkRequest, signal: AbortSignal): readonly LanguageLink[] {
		if (signal.aborted || request.languageId !== 'markdown' || !request.resource || (!getPromptFileType(request.resource) && request.resource.authority !== 'skill')) return [];
		const body = this.parser.parse(request.resource, request.snapshot.getText()).body;
		const home = this.paths.resolvedUserHome;
		const userHome = home?.scheme === request.resource.scheme && home.authority === request.resource.authority ? home : undefined;
		return body?.fileReferences.flatMap(reference => {
			const target = body.resolveFilePath(reference.content, userHome);
			return target ? [{ range: reference.range, target: target.toString(), tooltip: localize('prompt.references.open', 'Open referenced file') }] : [];
		}) ?? [];
	}
}
