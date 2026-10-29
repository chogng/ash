import { localize } from '../../../../../nls.js';
import type { IConfigurationPropertySchema } from '../../../../../platform/configuration/common/configurationRegistry.js';

export const enum TerminalAutoRepliesSettingId {
	AutoReplies = 'terminal.integrated.autoReplies',
}

export interface ITerminalAutoRepliesConfiguration {
	autoReplies: { [match: string]: string | null };
}

export const terminalAutoRepliesConfiguration: Readonly<Record<string, IConfigurationPropertySchema>> = {
	[TerminalAutoRepliesSettingId.AutoReplies]: {
		type: 'object',
		default: {},
		restricted: true,
		get markdownDescription() {
			return localize(
				'terminal.autoReplies.description',
				'Reply automatically when an exact message appears in raw terminal output. Each reply is sent at most once per second. Use `\\r` for Enter; null disables a reply. Up to 32 rules are supported, with 4 KiB per message or reply and 64 KiB total. Changes apply to running terminals.',
			);
		},
		maxProperties: 32,
		additionalProperties: { type: ['string', 'null'], maxLength: 4096 },
	},
};
