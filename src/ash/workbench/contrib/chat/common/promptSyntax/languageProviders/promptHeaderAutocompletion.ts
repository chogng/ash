import { IAgentCapabilitiesService } from '../../../../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
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

/** Offers only the root keys accepted by Ash's Skill catalog, through Stanza's provider contract. */
export class PromptHeaderAutocompletion implements LanguageCompletionProvider {
	public readonly id = 'ash.prompt.skillHeader';
	public readonly languageIds = ['markdown'];
	private readonly parser = new PromptFileParser();

	constructor(@IAgentCapabilitiesService private readonly capabilities: IAgentCapabilitiesService) { }

	public async provideCompletions(request: LanguageCompletionProviderRequest, signal: AbortSignal): Promise<LanguageCompletionProviderResult | undefined> {
		if (signal.aborted || !request.resource?.path.endsWith('/SKILL.md')) return undefined;
		const source = request.snapshot.getText();
		const parsed = this.parser.parse(request.resource, source);
		if (!parsed.header?.range.containsPosition(request.position)) return undefined;
		const lines = source.split(/\r\n|\n|\r/u);
		const line = lines[request.position.lineNumber - 1]!;
		const prefix = line.slice(0, request.position.column - 1);
		const tools = parsed.header.getAttribute('allowed-tools');
		if (tools?.range.startLineNumber === request.position.lineNumber && tools.value.type === 'scalar' && tools.value.format === 'none' && /^allowed-tools:\s/u.test(prefix) && this.capabilities.isAvailable) {
			const token = prefix.slice(prefix.indexOf(':') + 1).match(/\S*$/u)![0];
			const suffix = line.slice(request.position.column - 1).match(/^\S*/u)![0];
			const current = token + suffix;
			const existing = new Set(tools.value.value.split(/\s+/u).filter(name => name !== current));
			const catalog = await this.capabilities.read();
			if (signal.aborted) return undefined;
			const range = new Range(request.position.lineNumber, request.position.column - token.length, request.position.lineNumber, request.position.column + suffix.length);
			return { items: catalog.tools.filter(tool => (tool.exposure === 'direct' || tool.exposure === 'deferred') && tool.name.startsWith(token) && !existing.has(tool.name)).map(tool => ({ id: tool.name, label: tool.name, insertText: tool.name, range, kind: LanguageCompletionItemKind.Function, documentation: tool.description })), isIncomplete: true };
		}
		const name = parsed.header.getAttribute('name');
		if (name?.range.startLineNumber === request.position.lineNumber && /^name:\s*[a-z0-9-]*$/u.test(line) && prefix.includes(':')) {
			const parent = request.resource.path.split('/').at(-2)!;
			const start = line.indexOf(':') + 2 + (line.slice(line.indexOf(':') + 1).match(/^\s*/u)?.[0].length ?? 0);
			if (parent.length > getAttributeDefinition('name')!.maximumCharacters! || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(parent)) return undefined;
			return { items: [{ id: 'name-value', label: parent, insertText: line.endsWith(':') ? ` ${parent}` : parent, range: new Range(request.position.lineNumber, Math.min(start, line.length + 1), request.position.lineNumber, line.length + 1), kind: LanguageCompletionItemKind.Value, documentation: getAttributeDefinition('name')!.description }], isIncomplete: false };
		}
		if (!/^[a-z-]*$/u.test(prefix) || !/^[a-z-]*$/u.test(line)) return undefined;
		const existing = new Set(parsed.header.attributes.map(attribute => attribute.key));
		const range = new Range(request.position.lineNumber, 1, request.position.lineNumber, line.length + 1);
		return {
			items: getValidAttributeNames().filter(name => name.startsWith(prefix) && !existing.has(name)).map((name, index) => ({
				id: name, label: name, insertText: `${name}: `, range,
				kind: LanguageCompletionItemKind.Property,
				detail: localize('prompt.skill.field', 'Skill field'), documentation: getAttributeDefinition(name)!.description,
				sortText: String(index).padStart(2, '0'),
			})),
			isIncomplete: true,
		};
	}
}
