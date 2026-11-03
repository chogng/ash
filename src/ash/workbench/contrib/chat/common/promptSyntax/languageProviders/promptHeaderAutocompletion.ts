import { ILanguageModelsService } from '../../languageModels.js';
import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { IPromptsService } from '../service/promptsService.js';
import { IInstructionService } from '../../../../../../platform/instructions/common/instructionService.js';
import { ILanguageModelToolsService, isToolSet } from '../../tools/languageModelToolsService.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import {
	LanguageCompletionItemKind,
	type LanguageCompletionProvider,
	type LanguageCompletionProviderRequest,
	type LanguageCompletionProviderResult,
} from '../../../../../../editor/common/languages.js';
import { PromptFileParser } from '../promptFileParser.js';
import { getAttributeDefinition, getValidAttributeNames } from './promptFileAttributes.js';
import { localize } from '../../../../../../nls.js';
import { getPromptFileType, PromptsType } from '../promptTypes.js';

/** Offers the current definition's catalog keys through Stanza's provider contract. */
export class PromptHeaderAutocompletion implements LanguageCompletionProvider {
	public readonly id = 'ash.prompt.skillHeader';
	public readonly languageIds = ['markdown'];
	private readonly parser = new PromptFileParser();

	constructor(
		@ILanguageModelToolsService private readonly toolsService: ILanguageModelToolsService,
		@IPromptsService private readonly prompts: IPromptsService,
		@IInstructionService private readonly instructions: IInstructionService,
		@ILanguageModelsService private readonly models?: Pick<ILanguageModelsService, 'listModelCatalog'>,
	) { }

	public async provideCompletions(request: LanguageCompletionProviderRequest, signal: AbortSignal): Promise<LanguageCompletionProviderResult | undefined> {
		const type = request.resource && getPromptFileType(request.resource);
		if (signal.aborted || !request.resource || !type) { return undefined; }
		const source = request.snapshot.getText();
		const parsed = this.parser.parse(request.resource, source);
		if (!parsed.header?.range.containsPosition(request.position)) return undefined;
		const lines = source.split(/\r\n|\n|\r/u);
		const line = lines[request.position.lineNumber - 1]!;
		const prefix = line.slice(0, request.position.column - 1);
		const modelField = parsed.header.getAttribute('model');
		const modelLine = type === PromptsType.agent && modelField?.keyRange.startLineNumber === request.position.lineNumber
			&& /^model:([ \t]*)(['"]?)([a-zA-Z0-9_.:/-]*)(['"]?)$/u.exec(line);
		if (modelLine && /^model:/u.test(prefix) && this.models && (!modelLine[4] || modelLine[2] === modelLine[4])) {
			const start = 'model:'.length + modelLine[1].length;
			const token = prefix.slice(start + modelLine[2].length).replace(/['"]$/u, '');
			const range = new Range(request.position.lineNumber, start + 1, request.position.lineNumber, line.length + 1);
			const catalog = await this.models.listModelCatalog();
			if (signal.aborted) return undefined;
			const items = catalog.flatMap(entry => {
				const reference = `${entry.model.provider}/${entry.model.model}`;
				if (!reference.startsWith(token) || !/^[a-zA-Z0-9_.:/-]{1,128}$/u.test(reference)) return [];
				return [{
					id: reference, label: reference, detail: entry.displayName, documentation: entry.description ?? undefined,
					insertText: (start === 'model:'.length ? ' ' : '') + JSON.stringify(reference), range, kind: LanguageCompletionItemKind.Reference,
				}];
			});
			return { items, isIncomplete: true };
		}
		if (type === PromptsType.agent && this.toolsService.isAvailable) {
			const field = parsed.header.attributes.find(attribute => ['tools', 'disallowedTools', 'requiredTools', 'delegationTools', 'disallowedDelegationTools', 'requiredDelegationTools'].includes(attribute.key)
				&& attribute.value.type === 'sequence' && attribute.value.range.containsPosition(request.position));
			if (field?.value.type === 'sequence') {
				const current = field.value.items.find(item => item.range.containsPosition(request.position));
				const plainValue = current?.type === 'scalar' && current.format === 'none';
				const emptyValue = !current && (/[\[,]\s*$/u.test(prefix) || /^\s*-\s*$/u.test(prefix));
				if (plainValue || emptyValue) {
					const token = prefix.match(/[a-zA-Z0-9_.:/-]*$/u)![0];
					const suffix = line.slice(request.position.column - 1).match(/^[a-zA-Z0-9_.:/-]*/u)![0];
					const existing = new Set(field.value.items.flatMap(item => item !== current && item.type === 'scalar' ? [item.value] : []));
					await this.toolsService.refresh();
					if (signal.aborted) { return undefined; }
					const range = new Range(request.position.lineNumber, request.position.column - token.length, request.position.lineNumber, request.position.column + suffix.length);
					return {
						items: [...this.toolsService.getAllToolsIncludingDisabled()]
							.filter(tool => tool.canBeReferencedInPrompt && /^[a-zA-Z0-9_.:/-]{1,128}$/u.test(tool.toolReferenceName)
								&& tool.toolReferenceName.startsWith(token) && !existing.has(tool.toolReferenceName))
							.map(tool => ({
								id: tool.id, label: tool.toolReferenceName, insertText: tool.toolReferenceName, range,
								kind: LanguageCompletionItemKind.Function, documentation: tool.modelDescription,
							})),
						isIncomplete: true,
					};
				}
			}
		}
		if (type === PromptsType.agent) {
			const field = parsed.header.attributes.find(attribute => ['skills', 'requiredSkills', 'instructions'].includes(attribute.key)
				&& attribute.value.type === 'sequence' && attribute.value.range.containsPosition(request.position));
			if (field?.value.type === 'sequence') {
				const current = field.value.items.find(item => item.range.containsPosition(request.position));
				const plain = current?.type === 'scalar' && current.format === 'none';
				const empty = !current && (/[\[,]\s*$/u.test(prefix) || /^\s*-\s*$/u.test(prefix));
				if (!plain && !empty) return undefined;
				const token = prefix.match(/[a-zA-Z0-9_.:/-]*$/u)![0];
				const suffix = line.slice(request.position.column - 1).match(/^[a-zA-Z0-9_.:/-]*/u)![0];
				const existing = new Set(field.value.items.flatMap(item => item !== current && item.type === 'scalar' ? [item.value] : []));
				using cancellation = new CancellationTokenSource();
				const cancel = (): void => cancellation.cancel();
				signal.addEventListener('abort', cancel, { once: true });
				let entries: readonly { readonly name: string; readonly description?: string; }[];
				try {
					entries = field.key === 'instructions'
						? this.instructions.isAvailable ? await this.instructions.list() : []
						: (await this.prompts.findAgentSkills(cancellation.token)).filter(skill => skill.enabled && skill.compatible);
				} catch (error) {
					if (signal.aborted) return undefined;
					throw error;
				} finally { signal.removeEventListener('abort', cancel); }

				if (signal.aborted) return undefined;
				const range = new Range(request.position.lineNumber, request.position.column - token.length, request.position.lineNumber, request.position.column + suffix.length);
				const names = new Set<string>();
				return {
					items: entries.filter(entry => {
						if (!entry.name.startsWith(token) || existing.has(entry.name) || names.has(entry.name)) return false;
						names.add(entry.name);
						return true;
					})
						.map(entry => ({ id: entry.name, label: entry.name, insertText: JSON.stringify(entry.name), range, kind: LanguageCompletionItemKind.Reference, documentation: entry.description })),
					isIncomplete: true,
				};
			}
		}
		const tools = parsed.header.getAttribute('allowed-tools');
		if (tools?.range.startLineNumber === request.position.lineNumber && tools.value.type === 'scalar' && tools.value.format === 'none' && /^allowed-tools:\s/u.test(prefix) && this.toolsService.isAvailable) {
			const token = prefix.slice(prefix.indexOf(':') + 1).match(/\S*$/u)![0];
			const suffix = line.slice(request.position.column - 1).match(/^\S*/u)![0];
			const current = token + suffix;
			const existing = new Set(tools.value.value.split(/\s+/u).filter(name => name !== current));
			await this.toolsService.refresh();
			if (signal.aborted) return undefined;
			const range = new Range(request.position.lineNumber, request.position.column - token.length, request.position.lineNumber, request.position.column + suffix.length);
			const existingTools = new Set([...existing].map(name => this.toolsService.getToolByFullReferenceName(name)).filter(tool => tool !== undefined));
			const items = [...this.toolsService.getFullReferenceNames()]
				.filter(name => name.startsWith(token) && !existing.has(name) && !existingTools.has(this.toolsService.getToolByFullReferenceName(name)!))
				.map(name => {
					const tool = this.toolsService.getToolByFullReferenceName(name)!;
					return {
						id: name, label: name, insertText: name, range,
						kind: LanguageCompletionItemKind.Function,
						documentation: isToolSet(tool) ? [...tool.getTools()].filter(member => member.canBeReferencedInPrompt).map(member => member.displayName).join(', ') : tool.modelDescription,
					};
				});
			return { items, isIncomplete: true };
		}
		const name = parsed.header.getAttribute('name');
		if (name?.range.startLineNumber === request.position.lineNumber && /^name:\s*[a-z0-9-]*$/u.test(line) && prefix.includes(':')) {
			const parent = type === PromptsType.skill ? request.resource.path.split('/').at(-2)! : request.resource.path.split('/').at(-1)!.slice(0, -3);
			const start = line.indexOf(':') + 2 + (line.slice(line.indexOf(':') + 1).match(/^\s*/u)?.[0].length ?? 0);
			const valid = type === PromptsType.skill ? /^[a-z0-9]+(?:-[a-z0-9]+)*$/u : /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
			if (parent.length > 64 || !valid.test(parent)) { return undefined; }
			return { items: [{ id: 'name-value', label: parent, insertText: line.endsWith(':') ? ` ${parent}` : parent, range: new Range(request.position.lineNumber, Math.min(start, line.length + 1), request.position.lineNumber, line.length + 1), kind: LanguageCompletionItemKind.Value, documentation: getAttributeDefinition('name', type)!.description }], isIncomplete: false };
		}
		if (type === PromptsType.instructions && /^load:\s*[a-z-]*$/u.test(line) && /^load:\s/u.test(prefix)) {
			const start = line.indexOf(':') + 1 + (line.slice(line.indexOf(':') + 1).match(/^\s*/u)?.[0].length ?? 0);
			const typed = prefix.slice(start);
			return {
				items: ['global', 'contextual', 'on-demand'].filter(value => value.startsWith(typed)).map(value => ({
					id: value, label: value, insertText: value, kind: LanguageCompletionItemKind.Value,
					range: new Range(request.position.lineNumber, start + 1, request.position.lineNumber, line.length + 1),
				})), isIncomplete: true,
			};
		}
		if (!/^[a-zA-Z-]*$/u.test(prefix) || !/^[a-zA-Z-]*$/u.test(line)) return undefined;
		const existing = new Set(parsed.header.attributes.map(attribute => attribute.key));
		const range = new Range(request.position.lineNumber, 1, request.position.lineNumber, line.length + 1);
		return {
			items: getValidAttributeNames(type).filter(name => name.startsWith(prefix) && !existing.has(name)).map((name, index) => ({
				id: name, label: name, insertText: `${name}: `, range,
				kind: LanguageCompletionItemKind.Property,
				detail: type === PromptsType.skill ? localize('prompt.skill.field', 'Skill field') : localize('prompt.definition.field', 'Definition field'), documentation: getAttributeDefinition(name, type)!.description,
				sortText: String(index).padStart(2, '0'),
			})),
			isIncomplete: true,
		};
	}
}
