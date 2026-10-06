import type { JsonSchema } from '../../../../base/common/jsonSchema.js';

export const fileIconThemeSchemaId = 'vscode://schemas/icon-theme';

export const iconFontSchema: JsonSchema = {
	type: 'object', required: ['id', 'src'], additionalProperties: false,
	properties: {
		id: { type: 'string', minLength: 1 },
		size: { type: 'string', pattern: '^[1-9][0-9]{0,2}(?:\\.[0-9]+)?%$' },
		weight: { type: 'string', pattern: '^(?:normal|bold|[1-9]00)$' }, style: { enum: ['normal', 'italic', 'oblique'] },
		src: {
			type: 'array', minItems: 1, maxItems: 4, items: {
				type: 'object', required: ['path', 'format'], additionalProperties: false,
				properties: { path: { type: 'string' }, format: { enum: ['woff', 'woff2', 'truetype', 'opentype'] } },
			}
		},
	},
};

const associations: Readonly<Record<string, JsonSchema>> = {
	file: { type: 'string' }, folder: { type: 'string' },
	rootFolder: { type: 'string' },
	fileExtensions: { type: 'object', additionalProperties: { type: 'string' } },
	fileNames: { type: 'object', additionalProperties: { type: 'string' } },
	folderNames: { type: 'object', additionalProperties: { type: 'string' } },
	rootFolderNames: { type: 'object', additionalProperties: { type: 'string' } },
	languageIds: { type: 'object', additionalProperties: { type: 'string' } },
};

export const fileIconThemeSchema: JsonSchema = {
	type: 'object', allowComments: true, allowTrailingCommas: true, additionalProperties: false,
	properties: {
		$schema: { type: 'string' },
		fonts: { type: 'array', maxItems: 16, items: iconFontSchema },
		hidesExplorerArrows: { type: 'boolean' },
		iconDefinitions: {
			type: 'object', additionalProperties: {
				type: 'object', additionalProperties: false,
				properties: { iconPath: { type: 'string' }, fontCharacter: { type: 'string' }, fontId: { type: 'string' }, fontSize: { type: 'string' }, fontColor: { type: 'string', pattern: '^#(?:[\\da-fA-F]{3}|[\\da-fA-F]{4}|[\\da-fA-F]{6}|[\\da-fA-F]{8})$' } },
			}
		},
		...associations,
		light: { type: 'object', additionalProperties: false, properties: associations },
		highContrast: { type: 'object', additionalProperties: false, properties: associations },
	},
};
