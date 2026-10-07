import type { JsonSchema } from '../../../../base/common/jsonSchema.js';
import { getIconRegistry } from '../../../../platform/theme/common/iconRegistry.js';
import { iconFontSchema } from './fileIconThemeSchema.js';

export const productIconThemeSchemaId = 'vscode://schemas/product-icon-theme';
const definition: JsonSchema = {
	type: 'object', additionalProperties: false,
	oneOf: [{ required: ['iconPath'] }, { required: ['fontCharacter'] }],
	properties: {
		iconPath: { type: 'string', pattern: '\\.svg$' },
		fontCharacter: { type: 'string', minLength: 1, maxLength: 16 }, fontId: { type: 'string' },
	},
};

export const productIconThemeSchema: JsonSchema = {
	type: 'object', allowComments: true, allowTrailingCommas: true, additionalProperties: false,
	required: ['iconDefinitions'],
	properties: {
		$schema: { type: 'string' }, fonts: { type: 'array', maxItems: 16, items: iconFontSchema },
		iconDefinitions: {
			type: 'object', maxProperties: 512,
			get properties() { return Object.fromEntries(getIconRegistry().getIcons().map(icon => [icon.id, { ...definition, description: icon.description }])); },
			additionalProperties: definition,
		},
	},
};
