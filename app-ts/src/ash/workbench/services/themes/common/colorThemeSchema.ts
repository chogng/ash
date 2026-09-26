import type { JsonSchema } from '../../../../base/common/jsonSchema.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { JsonSchemasRegistry } from '../../../../platform/jsonschemas/common/jsonSchemaRegistry.js';
import { Colors } from '../../../../platform/theme/common/colorRegistry.js';
import '../../../../platform/theme/common/colorTheme.js';
import '../../../../editor/common/core/editorColorRegistry.js';

export const colorThemeSchemaId = 'vscode://schemas/color-theme';

const color: JsonSchema = { type: 'string', pattern: '^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$' };

/** Color-theme document shared by built-in, user, and extension themes. */
export const colorThemeSchema: JsonSchema = {
	type: 'object',
	allowComments: true,
	allowTrailingCommas: true,
	additionalProperties: false,
	properties: {
		$schema: { type: 'string' },
		include: { type: 'string', minLength: 1, maxLength: 1024 },
		name: { type: 'string', minLength: 1, maxLength: 256 },
		type: { enum: ['dark', 'light', 'hcDark', 'hcLight'] },
		colors: {
			type: 'object',
			get properties() {
				return Object.fromEntries(Colors.getColors().map(entry => [entry.id, { ...color, description: entry.description }]));
			},
			additionalProperties: color,
		},
		tokenColors: { anyOf: [{ type: 'string', minLength: 1, maxLength: 1024 }, {
			type: 'array',
			maxItems: 1024,
			items: {
				type: 'object',
				required: ['settings'],
				additionalProperties: false,
				properties: {
					name: { type: 'string' },
					scope: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
					settings: {
						type: 'object',
						additionalProperties: false,
						properties: {
							foreground: color,
							background: color,
							fontStyle: { type: 'string', pattern: '^\\s*(?:(?:italic|bold|underline|strikethrough)\\s*)*$' },
						},
					},
				},
			},
		}] },
		semanticHighlighting: { type: 'boolean' },
		semanticTokenColors: {
			type: 'object',
			additionalProperties: {
				anyOf: [color, {
					type: 'object',
					additionalProperties: false,
					properties: { foreground: color, fontStyle: { type: 'string', pattern: '^\\s*(?:(?:italic|bold|underline|strikethrough)\\s*)*$' }, bold: { type: 'boolean' }, italic: { type: 'boolean' }, underline: { type: 'boolean' }, strikethrough: { type: 'boolean' } },
				}],
			},
		},
	},
};

export function registerColorThemeSchemas(): IDisposable {
	return JsonSchemasRegistry.registerSchema(colorThemeSchemaId, colorThemeSchema);
}
