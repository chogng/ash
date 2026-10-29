import { localize } from '../../../../../../nls.js';

const skillAttributes = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'] as const;

/** Documents the existing Ash Skill format, without accepting or persisting metadata in the renderer. */
export function getValidAttributeNames(): readonly string[] {
	return skillAttributes;
}

export function getAttributeDefinition(name: string): { readonly description: string; readonly maximumCharacters?: number } | undefined {
	switch (name) {
		case 'name':
			return {
				maximumCharacters: 64,
				description: localize('prompt.skill.name', 'Required. A lowercase Skill name that matches its parent directory. Use letters, numbers and hyphens.'),
			};
		case 'description':
			return {
				maximumCharacters: 1024,
				description: localize('prompt.skill.description', 'Required. Describe when this Skill should be used, in 1 to 1024 characters.'),
			};
		case 'license':
			return { description: localize('prompt.skill.license', 'Optional license information for this Skill.') };
		case 'compatibility':
			return {
				maximumCharacters: 500,
				description: localize('prompt.skill.compatibility', 'Optional environment requirements, in up to 500 characters.'),
			};
		case 'metadata':
			return {
				description: localize('prompt.skill.metadata', 'Optional mapping of metadata names to string values.'),
			};
		case 'allowed-tools':
			return {
				maximumCharacters: 1024,
				description: localize('prompt.skill.allowedTools', 'Optional space-separated tool names. Tool execution still follows current permissions and the tool catalog.'),
			};
		default:
			return undefined;
	}
}
