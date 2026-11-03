import { Range } from '../../../../../../editor/common/core/range.js';
import type { LanguageCodeAction, LanguageCodeActionProvider, LanguageCodeActionRequest } from '../../../../../../editor/common/languages.js';
import { localize } from '../../../../../../nls.js';
import { PromptFileParser } from '../promptFileParser.js';
import { getPromptFileType, PromptsType } from '../promptTypes.js';
import { PromptValidator } from './promptValidator.js';

/** Repairs unambiguous draft errors through the editor's versioned workspace edit owner. */
export class PromptCodeActionProvider implements LanguageCodeActionProvider {
	public readonly providedCodeActionKinds = ['quickfix'];
	private readonly parser = new PromptFileParser();
	private readonly validator = new PromptValidator();

	public provideCodeActions(request: LanguageCodeActionRequest, signal: AbortSignal): readonly LanguageCodeAction[] {
		const type = getPromptFileType(request.resource);
		if (signal.aborted || request.languageId !== 'markdown' || !type
			|| request.only?.length && !request.only.some(kind => kind === 'quickfix' || kind === '')) {
			return [];
		}
		const prompt = this.parser.parse(request.resource, request.snapshot.getText());
		const header = prompt.header;
		if (!header || header.errors.length) { return []; }
		const actions: LanguageCodeAction[] = [];
		const add = (title: string, range: Range, text: string): void => {
			actions.push({
				title, kind: 'quickfix',
				edit: { entries: [{ kind: 'textDocument', resource: request.resource, version: request.snapshot.version, edits: [{ range, text }] }] },
			});
		};
		for (const diagnostic of this.validator.validate(prompt)) {
			if (!Range.areIntersectingOrTouching(diagnostic.range, request.range)) { continue; }
			if (diagnostic.code === 'nameMismatch') {
				const attribute = header.getAttribute('name');
				const name = type === PromptsType.skill ? request.resource.path.split('/').at(-2)! : request.resource.path.split('/').at(-1)!.slice(0, -3);
				const valid = type === PromptsType.skill ? /^[a-z0-9]+(?:-[a-z0-9]+)*$/u : /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
				if (attribute?.value.type === 'scalar' && ['none', 'single', 'double'].includes(attribute.value.format) && name.length <= 64 && valid.test(name)) {
					add(localize('prompt.definition.fixName', 'Use {0} as name', name), attribute.value.range, JSON.stringify(name));
				}
			}
			if (diagnostic.code === 'loadPolicy' && type === PromptsType.instructions) {
				const load = header.getAttribute('load');
				const patterns = header.getAttribute('patterns');
				if (load?.value.type !== 'scalar' || !['none', 'single', 'double'].includes(load.value.format)) { continue; }
				const policies = patterns?.value.type === 'sequence' && patterns.value.items.length > 0 ? ['contextual'] : ['global', 'on-demand'];
				for (const policy of policies) {
					add(localize('prompt.definition.fixLoad', 'Use {0} loading', policy), load.value.range, policy);
				}
			}
		}
		return actions;
	}
}
