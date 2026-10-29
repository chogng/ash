import { localize, localize2 } from '../../../../nls.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Menus } from '../../../browser/menus.js';
import { ISessionsSearchService, SessionsSearchService } from './searchService.js';

registerSingleton(ISessionsSearchService, SessionsSearchService, InstantiationType.Delayed);

registerAction2(
	class SearchSessions extends Action2 {
		constructor() {
			super({
				id: 'sessions.search',
				title: localize2('sessions.search.title', 'Search'),
				icon: Lxicon.search,
				f1: true,
				menu: [Menus.ActivityBar, Menus.CodeActivityBar].map(id => ({ id, group: 'navigation', order: 15 })),
			});
		}
		override run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(ISessionsSearchService).show();
		}
	},
);

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.SessionsSearch,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') {
			throw new TypeError(localize('sessions.search.verbosityInvalid', 'Search accessibility verbosity must be boolean'));
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('sessions.search.verbosityTitle', 'Search accessibility help'),
		description: localize('sessions.search.verbosityDescription', 'Announce how to open accessibility help when Search receives focus.'),
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 110,
	name: 'sessionsSearchHelp',
	when: ContextKeyExpr.has('sessionsSearchFocused'),
	getProvider: accessor => {
		const search = accessor.get(ISessionsSearchService);
		return new AccessibleContentProvider(
			AccessibleViewProviderId.SessionsSearch,
			{ type: AccessibleViewType.Help },
			() =>
				localize(
					'sessions.search.help',
					'Search finds saved sessions, loaded ChatGPT conversations, drafts, projects and schedules by name. ChatGPT conversations appear in All and Sessions and also match their project names. Type to filter results. Use Up and Down to select a result, then Enter to open it. Tab reaches the category buttons; use Left and Right to focus a category and Enter or Space to select it. Down returns to the search input. Escape closes Search and restores focus to the previous control.',
				),
			() => search.focus(),
			AccessibilityVerbositySettingId.SessionsSearch,
		);
	},
});
