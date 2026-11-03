import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';

export function readAutomationTemplates() {
	return [
		{ name: localize('automations.template.briefing', 'Daily briefing'), prompt: localize('automations.template.briefingPrompt', 'Review recent activity in this project. Summarize progress, flag blockers, and suggest the next priorities.'), weekdays: [1, 2, 3, 4, 5, 6, 7], hour: 9, icon: Lxicon.calendar },
		{ name: localize('automations.template.review', 'Review changes'), prompt: localize('automations.template.reviewPrompt', 'Review recent code changes for bugs and missing tests. Summarize actionable findings with file references.'), weekdays: [1, 2, 3, 4, 5], hour: 18, icon: Lxicon.code },
		{ name: localize('automations.template.recap', 'Weekly recap'), prompt: localize('automations.template.recapPrompt', 'Summarize this week’s project activity, completed work, and unresolved questions. Suggest priorities for next week.'), weekdays: [5], hour: 17, icon: Lxicon.check },
	];
}
