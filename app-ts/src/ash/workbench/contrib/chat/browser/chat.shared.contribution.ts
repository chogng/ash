import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);

/** Prompt typography belongs to the user's UI, independently of file and reply-code editors. */
export const ChatInputConfiguration = Object.freeze({
	fontFamily: configurationRegistry.registerConfiguration<string>({
		key: 'chat.input.fontFamily',
		defaultValue: '',
		scope: ConfigurationScope.APPLICATION,
		schema: { type: 'string', maxLength: 256, pattern: '^[^\\r\\n\\u0000]*$' },
		parse(value: unknown): string {
			if (typeof value === 'string' && value.length <= 256 && !/[\r\n\0]/u.test(value)) return value;
			throw new TypeError(localize('chat.input.fontFamily.invalid', 'Chat input font must be a single-line string no longer than 256 characters.'));
		},
		setting: {
			valueType: 'text',
			get title() { return localize('chat.input.fontFamily.title', 'Font family'); },
			get description() { return localize('chat.input.fontFamily.description', 'Set the font for messages you type. Leave empty to use the system UI font. This does not change replies or code blocks.'); },
			get placeholder() { return localize('chat.input.fontFamily.default', 'System default'); },
		},
	}),
	fontSize: configurationRegistry.registerConfiguration<number>({
		key: 'chat.input.fontSize',
		defaultValue: 13,
		scope: ConfigurationScope.APPLICATION,
		schema: { type: 'integer', minimum: 8, maximum: 40 },
		parse(value: unknown): number {
			if (typeof value === 'number' && Number.isInteger(value) && value >= 8 && value <= 40) return value;
			throw new RangeError(localize('chat.input.fontSize.invalid', 'Chat input font size must be an integer between 8 and 40.'));
		},
		setting: {
			valueType: 'number', minimum: 8, maximum: 40,
			get title() { return localize('chat.input.fontSize.title', 'Font size'); },
			get description() { return localize('chat.input.fontSize.description', 'Set the message input text size in pixels. The default is 13.'); },
		},
	}),
	lineHeight: configurationRegistry.registerConfiguration<number>({
		key: 'chat.input.lineHeight',
		defaultValue: 20,
		scope: ConfigurationScope.APPLICATION,
		schema: { anyOf: [{ const: 0 }, { type: 'integer', minimum: 8, maximum: 80 }] },
		parse(value: unknown): number {
			if (typeof value === 'number' && Number.isInteger(value) && (value === 0 || value >= 8 && value <= 80)) return value;
			throw new RangeError(localize('chat.input.lineHeight.invalid', 'Chat input line height must be 0 or an integer between 8 and 80.'));
		},
		setting: {
			valueType: 'number', minimum: 0, maximum: 80,
			get title() { return localize('chat.input.lineHeight.title', 'Line height'); },
			get description() { return localize('chat.input.lineHeight.description', 'Set the message input line height in pixels. The default is 20. Use 0 to calculate it from the font size.'); },
		},
	}),
});

export const autoAcceptDelaySetting = Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<number>({
	key: 'chat.editing.autoAcceptDelay',
	defaultValue: 0,
	scope: ConfigurationScope.WINDOW,
	schema: { type: 'number', minimum: 0, maximum: 100 },
	parse: value => {
		if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
			throw new TypeError('chat.editing.autoAcceptDelay must be a number between 0 and 100');
		}
		return value;
	},
	setting: {
		valueType: 'number', minimum: 0, maximum: 100,
		get title() { return localize('chatEditing.autoAcceptTitle', 'Automatically accept Agent changes'); },
		get description() { return localize('chatEditing.autoAcceptDescription', 'Seconds to wait before accepting edits after the reply completes. Set to 0 to review changes manually. You can cancel the countdown to keep reviewing.'); },
	},
});
