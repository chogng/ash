import { localize } from '../../../../../../nls.js';
import { PromptsType } from '../promptTypes.js';

const skillAttributes = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'] as const;
const agentAttributes = [
	'name', 'description', 'model', 'tools', 'disallowedTools', 'requiredTools',
	'delegationTools', 'disallowedDelegationTools', 'requiredDelegationTools',
	'skills', 'requiredSkills', 'instructions',
] as const;
const instructionAttributes = ['name', 'description', 'load', 'patterns'] as const;

/** Documents the shared catalogs' formats without accepting or persisting definitions in the renderer. */
export function getValidAttributeNames(type: PromptsType = PromptsType.skill): readonly string[] {
	if (type === PromptsType.agent) { return agentAttributes; }
	if (type === PromptsType.instructions) { return instructionAttributes; }
	return skillAttributes;
}

export function getAttributeDefinition(name: string, type: PromptsType = PromptsType.skill): { readonly description: string; readonly maximumCharacters?: number; } | undefined {
	if (type !== PromptsType.skill) {
		if (!getValidAttributeNames(type).includes(name)) { return undefined; }
		switch (name) {
			case 'name':
				return { maximumCharacters: 64, description: localize('prompt.definition.name', 'A lowercase name matching the Markdown filename, using letters, numbers and hyphens.') };
			case 'description':
				return { maximumCharacters: 1024, description: localize('prompt.definition.description', 'Describe when to use this definition, in up to 1024 UTF-8 bytes. Required for Agents.') };
			case 'model':
				return { description: localize('prompt.definition.model', 'Optional model reference. Model availability and credentials are resolved by the backend.') };
			case 'load':
				return { description: localize('prompt.definition.load', 'Required. Use global, contextual or on-demand. Only contextual Instructions declare patterns.') };
			case 'patterns':
				return { description: localize('prompt.definition.patterns', 'For contextual Instructions, provide 1 to 32 relative glob patterns, each up to 256 UTF-8 bytes.') };
			case 'instructions':
				return { description: localize('prompt.definition.instructions', 'A sequence of Instruction references. The backend loads their authorized contents for the Agent.') };
			case 'skills':
			case 'requiredSkills':
				return { description: localize('prompt.definition.skills', 'A sequence of Skill references. Required Skills must remain available after role filtering.') };
			default:
				return { description: localize('prompt.definition.tools', 'A sequence of tool references for this role. Required tools must remain available after filtering. Declarations do not grant execution permission.') };
		}
	}
	switch (name) {
		case 'name':
			return { maximumCharacters: 64, description: localize('prompt.skill.name', 'Required. A lowercase Skill name that matches its parent directory. Use letters, numbers and hyphens.') };
		case 'description':
			return { maximumCharacters: 1024, description: localize('prompt.skill.description', 'Required. Describe when this Skill should be used, in 1 to 1024 characters.') };
		case 'license':
			return { description: localize('prompt.skill.license', 'Optional license information for this Skill.') };
		case 'compatibility':
			return { maximumCharacters: 500, description: localize('prompt.skill.compatibility', 'Optional environment requirements, in up to 500 characters.') };
		case 'metadata':
			return { description: localize('prompt.skill.metadata', 'Optional mapping of metadata names to string values.') };
		case 'allowed-tools':
			return { maximumCharacters: 1024, description: localize('prompt.skill.allowedTools', 'Optional space-separated tool names. Tool execution still follows current permissions and the tool catalog.') };
		default:
			return undefined;
	}
}
