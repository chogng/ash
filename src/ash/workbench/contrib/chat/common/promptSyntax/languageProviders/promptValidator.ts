import { Range } from '../../../../../../editor/common/core/range.js';
import { LanguageDiagnosticSeverity, type LanguageDiagnostic } from '../../../../../../editor/common/languages.js';
import { localize } from '../../../../../../nls.js';
import type { IHeaderAttribute, ParsedPromptFile } from '../promptFileParser.js';
import { getAttributeDefinition, getValidAttributeNames } from './promptFileAttributes.js';
import { getPromptFileType, PromptsType } from '../promptTypes.js';

export const MARKERS_OWNER_ID = 'prompts-diagnostics-provider';

/** Draft feedback only; the owning backend catalogs validate saved definitions. */
export class PromptValidator {
	public validate(promptAST: ParsedPromptFile): readonly LanguageDiagnostic[] {
		const type = getPromptFileType(promptAST.uri);
		if (type === PromptsType.agent || type === PromptsType.instructions) {
			return this.validateDefinition(promptAST, type);
		}
		const header = promptAST.header;
		if (!header) return [{ range: promptAST.body?.range ?? new Range(1, 1, 1, 1), severity: LanguageDiagnosticSeverity.Error, code: 'missingHeader', source: 'Skill', message: localize('prompt.validation.header', 'A Skill requires a YAML header enclosed by --- lines.') }];
		const diagnostics: LanguageDiagnostic[] = header.errors.map(error => ({ ...error, severity: LanguageDiagnosticSeverity.Error, source: 'Skill' }));
		if (header.errors.some(error => error.code === 'headerTooLarge')) return diagnostics;
		const known = new Set(getValidAttributeNames());
		const report = (attribute: IHeaderAttribute, code: string, message: string): void => {
			diagnostics.push({ range: attribute.value.range, severity: LanguageDiagnosticSeverity.Error, code, source: 'Skill', message });
		};
		const length = (value: string): number => [...value].length;
		for (const attribute of header.attributes) {
			if (!known.has(attribute.key)) {
				diagnostics.push({ range: attribute.range, severity: LanguageDiagnosticSeverity.Error, code: 'unknownField', source: 'Skill', message: localize('prompt.validation.unknown', 'The Skill catalog does not accept the field {0}.', attribute.key) });
			} else if (attribute.key === 'metadata') {
				if (attribute.value.type !== 'map' || attribute.value.properties.some(property => property.value.type !== 'scalar' || property.value.missing)) {
					diagnostics.push({ range: attribute.value.range, severity: LanguageDiagnosticSeverity.Error, code: 'metadataShape', source: 'Skill', message: localize('prompt.validation.metadata', 'Metadata must map names to text values.') });
				} else if (attribute.value.properties.length > 64 || attribute.value.properties.some(property => !property.key.value || length(property.key.value) > 128 || property.value.type === 'scalar' && length(property.value.value) > 1024)) {
					report(attribute, 'metadataLimits', localize('prompt.validation.metadataLimits', 'Metadata supports up to 64 entries, with names of 1 to 128 characters and values of up to 1024 characters.'));
				}
			} else if (attribute.value.type !== 'scalar') {
				diagnostics.push({ range: attribute.value.range, severity: LanguageDiagnosticSeverity.Error, code: 'textField', source: 'Skill', message: localize('prompt.validation.text', 'The Skill field {0} requires a text value.', attribute.key) });
			} else if (!attribute.value.missing) {
				const value = attribute.value.value;
				if (attribute.key === 'name' && value) {
					if (value.length > getAttributeDefinition('name')!.maximumCharacters! || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
						report(attribute, 'invalidName', localize('prompt.validation.name', 'A Skill name requires 1 to 64 lowercase letters, numbers and single hyphens.'));
					} else {
						const directory = promptAST.uri.path.split('/').at(-2);
						if (directory && value !== directory) report(attribute, 'nameMismatch', localize('prompt.validation.nameMismatch', 'The Skill name {0} must match its parent directory {1}.', value, directory));
					}
				}
				const maximum = attribute.key === 'name' ? undefined : getAttributeDefinition(attribute.key)?.maximumCharacters;
				if (maximum !== undefined && ((!value.trim() && attribute.key === 'compatibility') || (!value && attribute.key === 'allowed-tools') || length(value) > maximum)) {
					report(attribute, 'fieldLength', localize('prompt.validation.length', 'The Skill field {0} requires 1 to {1} characters.', attribute.key, maximum));
				}
			}
		}
		for (const key of ['name', 'description']) {
			const attribute = header.getAttribute(key);
			if (!attribute || (attribute.value.type === 'scalar' && (attribute.value.missing || !attribute.value.value.trim()))) {
				diagnostics.push({ range: attribute?.range ?? header.range, severity: LanguageDiagnosticSeverity.Error, code: 'requiredField', source: 'Skill', message: localize('prompt.validation.required', 'The Skill header requires a non-empty {0} field.', key) });
			}
		}
		return diagnostics;
	}

	private validateDefinition(prompt: ParsedPromptFile, type: PromptsType.agent | PromptsType.instructions): readonly LanguageDiagnostic[] {
		const source = type === PromptsType.agent ? localize('prompt.definition.agent', 'Agent') : localize('prompt.definition.instruction', 'Instructions');
		const diagnostics: LanguageDiagnostic[] = [];
		const report = (range: Range, code: string, message: string): void => {
			diagnostics.push({ range, code, message, source, severity: LanguageDiagnosticSeverity.Error });
		};
		const bytes = (value: string): number => new TextEncoder().encode(value).length;
		const header = prompt.header;
		const whole = header?.range ?? prompt.body?.range ?? new Range(1, 1, 1, 1);
		if (bytes(prompt.content) > 32 * 1024) {
			report(whole, 'fileTooLarge', localize('prompt.syntax.definitionLimit', 'Agent and Instruction files support up to 32 KiB of UTF-8 text.'));
			return diagnostics;
		}
		if (!header) {
			report(whole, 'missingHeader', localize('prompt.definition.header', 'This definition requires a YAML header enclosed by --- lines.'));
			return diagnostics;
		}
		for (const error of header.errors) {
			diagnostics.push({ ...error, source, severity: error.code === 'unsupportedYaml' ? LanguageDiagnosticSeverity.Warning : LanguageDiagnosticSeverity.Error });
		}
		// Do not infer field values from an incomplete or unsupported YAML tree.
		if (header.errors.length) { return diagnostics; }
		const agent = type === PromptsType.agent;
		const expectedName = prompt.uri.path.split('/').at(-1)!.slice(0, -3);
		const known = new Set(getValidAttributeNames(type));
		const lists = new Map<string, readonly string[]>();
		const optionalLists = new Set(['tools', 'delegationTools', 'skills']);
		const reference = (value: string): boolean => /^[a-zA-Z0-9_.:/-]{1,128}$/u.test(value);
		for (const attribute of header.attributes) {
			const { key, value } = attribute;
			// Directory roles may spell the product defaults, but cannot claim packaged authority.
			if (agent && ['version', 'launch', 'callers', 'delegates'].includes(key)) {
				const isDefault = (key === 'version' || key === 'delegates') && value.type === 'scalar' && value.missing
					|| key === 'launch' && value.type === 'scalar' && value.value === 'any'
					|| key === 'callers' && value.type === 'sequence' && value.items.length === 0;
				if (!isDefault) {
					report(value.range, 'productField', localize('prompt.definition.productField', 'The field {0} cannot restrict product launches or packaged roles in a directory definition.', key));
				}
				continue;
			}
			if (!known.has(key)) {
				report(attribute.keyRange, 'unknownField', localize('prompt.definition.unknown', 'The {0} format does not accept the field {1}.', source, key));
				continue;
			}
			if (['name', 'description', 'model', 'load'].includes(key)) {
				const optional = !agent && (key === 'name' || key === 'description') || key === 'model';
				if (value.type === 'scalar' && value.missing && optional) { continue; }
				if (value.type !== 'scalar' || value.missing) {
					report(value.range, 'textField', localize('prompt.definition.text', 'The field {0} requires a text value.', key));
					continue;
				}
				if (key === 'name' && (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value.value) || value.value !== expectedName)) {
					report(value.range, 'nameMismatch', localize('prompt.definition.nameMismatch', 'The name must match the lowercase filename {0}, using 1 to 64 letters, numbers and hyphens.', expectedName));
				}
				if (key === 'description' && (!value.value.trim() || bytes(agent ? value.value.trim() : value.value) > 1024)) {
					report(value.range, 'descriptionLength', localize('prompt.definition.descriptionLength', 'The description requires 1 to 1024 UTF-8 bytes.'));
				}
				if (key === 'model' && (!reference(value.value) || !/^[^/]+\/.+$/u.test(value.value))) {
					report(value.range, 'invalidReference', localize('prompt.definition.modelReference', 'Use a provider/model reference of up to 128 letters, numbers or characters from - _ . : /.'));
				}
				continue;
			}
			if (value.type === 'scalar' && value.missing && optionalLists.has(key)) { continue; }
			if (value.type !== 'sequence' || value.items.some(item => item.type !== 'scalar' || item.missing)) {
				report(value.range, 'sequenceField', localize('prompt.definition.sequence', 'The field {0} requires a sequence of text values.', key));
				continue;
			}
			const values = value.items.flatMap(item => item.type === 'scalar' ? [item.value] : []);
			lists.set(key, values);
			if (agent && (values.some(item => !reference(item)) || new Set(values).size !== values.length)) {
				report(value.range, 'invalidReference', localize('prompt.definition.uniqueReferences', 'References must be valid and unique within each field.'));
			}
			if (key === 'patterns' && (values.length > 32 || values.some(item => !item.trim() || bytes(item) > 256 || item.startsWith('/') || item.split('/').includes('..')))) {
				report(value.range, 'invalidPatterns', localize('prompt.definition.patternLimits', 'Use up to 32 relative glob patterns, each with 1 to 256 UTF-8 bytes and no parent-directory traversal.'));
			}
		}
		const required = agent ? ['name', 'description'] : ['load'];
		for (const key of required) {
			if (!header.getAttribute(key)) {
				report(header.range, 'requiredField', localize('prompt.definition.required', 'The {0} header requires the field {1}.', source, key));
			}
		}
		if (!prompt.body?.getContent().trim()) {
			report(whole, 'emptyBody', localize('prompt.definition.body', 'Write the definition instructions in the Markdown body.'));
		}
		if (agent) {
			for (const [requiredKey, allowedKey, deniedKey] of [
				['requiredTools', 'tools', 'disallowedTools'],
				['requiredDelegationTools', 'delegationTools', 'disallowedDelegationTools'],
				['requiredSkills', 'skills', ''],
			] as const) {
				const allowed = lists.get(allowedKey);
				const denied = lists.get(deniedKey);
				if (lists.get(requiredKey)?.some(item => allowed && !allowed.includes(item) || denied?.includes(item))) {
					report(header.getAttribute(requiredKey)!.value.range, 'unavailableReference', localize('prompt.definition.filteredReference', 'References in {0} must remain available after role filtering.', requiredKey));
				}
			}
		} else {
			const load = header.getAttribute('load');
			if (load?.value.type === 'scalar' && !load.value.missing) {
				const policy = load.value.value;
				const patterns = lists.get('patterns') ?? [];
				if (!['global', 'contextual', 'on-demand'].includes(policy) || (policy === 'contextual' ? !patterns.length : patterns.length > 0)) {
					report(load.value.range, 'loadPolicy', localize('prompt.definition.loadPolicy', 'Use global or on-demand without patterns, or contextual with at least one relative glob pattern.'));
				}
			}
		}
		return diagnostics;
	}
}
