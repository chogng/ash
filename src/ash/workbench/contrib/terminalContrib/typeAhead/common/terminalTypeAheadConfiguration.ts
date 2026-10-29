import { localize } from '../../../../../nls.js';
import type { IConfigurationPropertySchema } from '../../../../../platform/configuration/common/configurationRegistry.js';

export const DEFAULT_LOCAL_ECHO_EXCLUDE: readonly string[] = ['vim', 'vi', 'nano', 'tmux'];
export const enum TerminalTypeAheadSettingId {
	LocalEchoLatencyThreshold = 'terminal.integrated.localEchoLatencyThreshold',
	LocalEchoEnabled = 'terminal.integrated.localEchoEnabled',
	LocalEchoExcludePrograms = 'terminal.integrated.localEchoExcludePrograms',
	LocalEchoStyle = 'terminal.integrated.localEchoStyle',
}

export const terminalTypeAheadConfiguration: Readonly<Record<string, IConfigurationPropertySchema>> = {
	[TerminalTypeAheadSettingId.LocalEchoEnabled]: {
		type: 'string',
		enum: ['on', 'off', 'auto'],
		default: 'off',
		get description() {
			return localize(
				'terminal.typeAhead.enabled',
				'Predict terminal input locally. Auto enables predictions for remote terminals when echo latency exceeds the configured threshold.',
			);
		},
	},
	[TerminalTypeAheadSettingId.LocalEchoLatencyThreshold]: {
		type: 'integer',
		minimum: -1,
		default: 30,
		get description() {
			return localize(
				'terminal.typeAhead.threshold',
				'Echo latency in milliseconds before automatic input prediction is shown. Zero always predicts; -1 disables automatic prediction.',
			);
		},
	},
	[TerminalTypeAheadSettingId.LocalEchoExcludePrograms]: {
		type: 'array',
		items: { type: 'string' },
		default: DEFAULT_LOCAL_ECHO_EXCLUDE,
		get description() {
			return localize(
				'terminal.typeAhead.exclude',
				'Disable input prediction when the terminal title contains one of these program names.',
			);
		},
	},
	[TerminalTypeAheadSettingId.LocalEchoStyle]: {
		type: 'string',
		default: 'dim',
		pattern: '^(bold|dim|italic|underlined|inverted|#[0-9a-fA-F]{6})$',
		get description() {
			return localize(
				'terminal.typeAhead.style',
				'Style of predicted input: bold, dim, italic, underlined, inverted, or an RGB hex color.',
			);
		},
	},
};
