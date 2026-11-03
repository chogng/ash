import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import type { LanguageDefinitionProvider, LanguageLocation, LanguageLocationRequest } from '../../../../../../editor/common/languages.js';
import { IInstructionService } from '../../../../../../platform/instructions/common/instructionService.js';
import { IPathService } from '../../../../../../platform/path/common/pathService.js';
import { PromptFileParser } from '../promptFileParser.js';
import { getPromptFileType, PromptsType } from '../promptTypes.js';
import { IPromptsService } from '../service/promptsService.js';

/** Navigates references using the currently authorized catalogs; it never discovers sources itself. */
export class PromptHeaderDefinitionProvider implements LanguageDefinitionProvider {
	private readonly parser = new PromptFileParser();

	constructor(
		@IPromptsService private readonly prompts: IPromptsService,
		@IInstructionService private readonly instructions: IInstructionService,
		@IPathService private readonly paths: IPathService,
	) { }

	public async provideDefinition(request: LanguageLocationRequest, signal: AbortSignal): Promise<readonly LanguageLocation[]> {
		if (signal.aborted || request.languageId !== 'markdown' || getPromptFileType(request.resource) !== PromptsType.agent) { return []; }
		const header = this.parser.parse(request.resource, request.snapshot.getText()).header;
		if (!header || header.errors.length) { return []; }
		const attribute = header.attributes.find(attribute => ['skills', 'requiredSkills', 'instructions'].includes(attribute.key)
			&& attribute.value.range.containsPosition(request.position));
		if (attribute?.value.type !== 'sequence') { return []; }
		const reference = attribute.value.items.find(item => item.type === 'scalar' && !item.missing && item.range.containsPosition(request.position));
		if (reference?.type !== 'scalar') { return []; }
		const start = new Range(1, 1, 1, 1);
		if (attribute.key !== 'instructions') {
			const skills = await this.prompts.findAgentSkills(CancellationToken.None);
			if (signal.aborted) { return []; }
			return skills.filter(skill => skill.name === reference.value).map(skill => ({ resource: skill.uri, range: start }));
		}
		if (!this.instructions.isAvailable) { return []; }
		const entries = await this.instructions.list();
		if (signal.aborted) { return []; }
		const locations: LanguageLocation[] = [];
		for (const entry of entries) {
			if (entry.name !== reference.value) { continue; }
			const resource = entry.resource ?? await this.paths.fileURI(entry.path);
			if (signal.aborted) { return []; }
			// A catalog-owned resource can cross namespaces. A bare host path cannot
			// silently become a reference into another host than the edited document.
			if (entry.resource || resource.scheme === request.resource.scheme && resource.authority === request.resource.authority) {
				locations.push({ resource, range: start });
			}
		}
		return locations;
	}
}
