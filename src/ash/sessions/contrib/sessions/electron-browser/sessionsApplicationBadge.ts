import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableSignalFromEvent } from '../../../../base/common/observable.js';
import { isWindows } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import type { IApplicationBadge } from '../../../../platform/native/common/native.js';
import { badgeBackground, badgeForeground } from '../../../../platform/theme/common/colors/miscColors.js';
import { IThemeService, type IColorTheme } from '../../../../platform/theme/common/themeService.js';
import { IGitHubService } from '../../github/browser/githubService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

export const SESSIONS_APPLICATION_BADGE_SETTING = 'sessions.showApplicationBadge';
export const SESSIONS_APPLICATION_BADGE_DEFAULT = true;
export const SESSIONS_APPLICATION_BADGE_OPTIONS_SETTING = 'sessions.applicationBadge';
export const SESSIONS_APPLICATION_BADGE_OPTIONS_DEFAULT = { inputNeeded: true, ciFailing: false };

export class SessionsApplicationBadge extends Disposable {
	static readonly ID = 'workbench.contrib.sessionsApplicationBadge';

	constructor(
		publish: (badge: IApplicationBadge) => Promise<void>,
		@ISessionsManagementService sessions: ISessionsManagementService,
		@IGitHubService github: IGitHubService,
		@IConfigurationService configuration: IConfigurationService,
		@IThemeService themes: IThemeService,
		@ILayoutService layout: ILayoutService,
	) {
		super();
		const catalogChanged = observableSignalFromEvent(this, sessions.onDidChange);
		const checksChanged = observableSignalFromEvent(this, github.onDidChange);
		const configurationChanged = observableSignalFromEvent(this, listener => configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(SESSIONS_APPLICATION_BADGE_SETTING) || event.affectsConfiguration(SESSIONS_APPLICATION_BADGE_OPTIONS_SETTING)) listener(event);
		}));
		const themeChanged = observableSignalFromEvent(this, themes.onDidColorThemeChange);
		let previousCount = 0;
		let previousTheme: IColorTheme | undefined;
		this._register(autorun(reader => {
			configurationChanged.read(reader);
			let count = 0;
			if (configuration.getValue<boolean>(SESSIONS_APPLICATION_BADGE_SETTING) ?? SESSIONS_APPLICATION_BADGE_DEFAULT) {
				catalogChanged.read(reader);
				const options = configuration.getValue<typeof SESSIONS_APPLICATION_BADGE_OPTIONS_DEFAULT>(SESSIONS_APPLICATION_BADGE_OPTIONS_SETTING)
					?? SESSIONS_APPLICATION_BADGE_OPTIONS_DEFAULT;
				if (options.ciFailing) checksChanged.read(reader);
				for (const session of sessions.sessions) {
					if (session.status !== 'active') continue;
					const chats = session.chats.filter(chat => chat.status === 'active' && chat.origin.type !== 'agentSpawn');
					const needsInput = options.inputNeeded && (session.management?.status === 'needsInput' || chats.some(chat => chat.management?.status === 'needsInput'));
					const working = session.management?.status === 'working' || chats.some(chat => chat.executionStatus === 'running' || chat.executionStatus === 'queued' || chat.management?.status === 'working');
					if (needsInput || (options.ciFailing && !working && github.getSessionPullRequests(session.sessionId).some(request => request.state === 'open' && request.status.hasFailingChecks))) count++;
				}
			}
			let theme: IColorTheme | undefined;
			if (isWindows && count) {
				themeChanged.read(reader);
				theme = themes.getColorTheme();
			}
			if (count === previousCount && theme === previousTheme) return;
			previousCount = count;
			previousTheme = theme;
			const description = count === 0 ? '' : count === 1
				? localize({ bundle: 'ash.sessions', key: 'sessions.applicationBadge.single' }, '1 session needs your attention')
				: localize({ bundle: 'ash.sessions', key: 'sessions.applicationBadge.multiple' }, '{0} sessions need your attention', count);
			const iconDataURL = theme && renderBadgeIcon(layout.mainContainer.ownerDocument, theme, count);
			void publish({ count, description, iconDataURL }).catch(onUnexpectedError);
		}));
		this._register(toDisposable(() => {
			if (previousCount) void publish({ count: 0, description: '' }).catch(onUnexpectedError);
		}));
	}
}

function renderBadgeIcon(document: Document, theme: IColorTheme, count: number): string | undefined {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 32;
	const context = canvas.getContext('2d');
	if (!context) return undefined;
	context.fillStyle = theme.getColorCss(badgeBackground) ?? '#000000';
	context.beginPath();
	context.arc(16, 16, 16, 0, 2 * Math.PI);
	context.fill();
	context.fillStyle = theme.getColorCss(badgeForeground) ?? '#ffffff';
	context.font = 'bold 20px sans-serif';
	context.textAlign = 'center';
	context.textBaseline = 'middle';
	context.fillText(count > 9 ? '9+' : String(count), 16, 16, 28);
	return canvas.toDataURL();
}
