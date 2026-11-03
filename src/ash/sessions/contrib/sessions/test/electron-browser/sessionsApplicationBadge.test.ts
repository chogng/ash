import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ConfigurationTarget, type IConfigurationChangeEvent, type IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import type { IApplicationBadge } from '../../../../../platform/native/common/native.js';
import type { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import type { IGitHubService } from '../../../github/browser/githubService.js';
import type { ISession } from '../../../../services/sessions/common/session.js';
import type { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { SESSIONS_APPLICATION_BADGE_SETTING, SessionsApplicationBadge } from '../../electron-browser/sessionsApplicationBadge.js';

test('the Sessions application badge deduplicates attention reasons and clears on disable and disposal', () => {
	using catalogChanged = new Emitter<void>();
	using settingsChanged = new Emitter<IConfigurationChangeEvent>();
	let enabled = true;
	const session: ISession = {
		sessionId: 'attention', title: 'Attention', status: 'active', nextApprovalMode: 'manual',
		management: { status: 'needsInput', statusChangedAtUnixMs: 1 }, chats: [],
	};
	let catalog = [session, { ...session, sessionId: 'archived', status: 'archived' as const }];
	const published: IApplicationBadge[] = [];
	const theme = { getColorCss: () => undefined };
	const canvas = { getContext: () => null };
	using badge = new SessionsApplicationBadge(async value => { published.push(value); },
		{ get sessions() { return catalog; }, onDidChange: catalogChanged.event } as unknown as ISessionsManagementService,
		{ onDidChange: Event.None, getSessionPullRequests: () => [{ state: 'open', status: { hasFailingChecks: true } }] } as unknown as IGitHubService,
		{
			onDidChangeConfiguration: settingsChanged.event,
			getValue: (key: string) => key === SESSIONS_APPLICATION_BADGE_SETTING ? enabled : { inputNeeded: true, ciFailing: true },
		} as unknown as IConfigurationService,
		{ onDidColorThemeChange: Event.None, getColorTheme: () => theme } as unknown as IThemeService,
		{ mainContainer: { ownerDocument: { createElement: () => canvas } } } as unknown as ILayoutService);
	catalog = [...catalog, { ...session, sessionId: 'ci', management: undefined }];
	catalogChanged.fire();
	const changed: IConfigurationChangeEvent = {
		source: ConfigurationTarget.USER,
		affectedKeys: new Set([SESSIONS_APPLICATION_BADGE_SETTING]),
		change: { keys: [SESSIONS_APPLICATION_BADGE_SETTING], overrides: [] },
		affectsConfiguration: key => key === SESSIONS_APPLICATION_BADGE_SETTING,
	};
	enabled = false;
	settingsChanged.fire(changed);
	enabled = true;
	settingsChanged.fire(changed);
	badge.dispose();
	assert.deepEqual(published.map(value => value.count), [1, 2, 0, 2, 0]);
});
