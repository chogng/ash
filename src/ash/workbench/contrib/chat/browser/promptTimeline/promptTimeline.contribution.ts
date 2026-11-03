import { localize } from '../../../../../nls.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { PROMPT_TIMELINE_DISPLAY_SETTING, PROMPT_TIMELINE_STICKY_SCROLL_SETTING, PROMPT_TIMELINE_RAIL_STYLES, type PromptTimelineRailStyle } from '../../common/promptTimeline.js';

const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);

registry.registerConfiguration<boolean>({
	key: PROMPT_TIMELINE_STICKY_SCROLL_SETTING,
	defaultValue: true,
	scope: ConfigurationScope.WINDOW,
	schema: { type: 'boolean' },
	parse(value: unknown): boolean {
		if (typeof value === 'boolean') { return value; }
		throw new TypeError(localize('chat.stickyScroll.invalid', 'Chat sticky scroll must be a boolean.'));
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('chat.stickyScroll.title', 'Sticky scroll'); },
		get description() { return localize('chat.stickyScroll.enabled', 'Pin the current user message to the top of the conversation while scrolling.'); },
	},
});

registry.registerConfiguration<PromptTimelineRailStyle>({
	key: PROMPT_TIMELINE_DISPLAY_SETTING,
	defaultValue: 'gutter',
	scope: ConfigurationScope.WINDOW,
	schema: { type: 'string', enum: [...PROMPT_TIMELINE_RAIL_STYLES] },
	parse(value: unknown): PromptTimelineRailStyle {
		if (value === 'off' || value === 'gutter' || value === 'ruler') return value;
		throw new TypeError(localize('chat.promptTimeline.invalid', 'Choose off, gutter or ruler for the prompt timeline.'));
	},
	setting: {
		valueType: 'select',
		get title() { return localize('chat.promptTimeline.title', 'Prompt timeline'); },
		get description() { return localize('chat.promptTimeline.description', 'Choose a prompt list in the gutter, an overview ruler, or no timeline in the Agents window.'); },
		get options() {
			return [
				{ value: 'off' as const, label: localize('chat.promptTimeline.off', 'Off') },
				{ value: 'gutter' as const, label: localize('chat.promptTimeline.gutter', 'Gutter') },
				{ value: 'ruler' as const, label: localize('chat.promptTimeline.ruler', 'Overview ruler') },
			];
		},
	},
});
