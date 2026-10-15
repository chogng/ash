import { Disposable } from '../../../../base/common/lifecycle.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import { browserPageScheme } from '../../../../platform/browserView/common/browserPage.js';
import { BrowserViewStorageScope, IBrowserViewService } from '../../../../platform/browserView/common/browserView.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';

// A window-owned product page, independent of Agent sessions and their archive lifecycle.
export const chatGPTBrowserId = 'browser_target_61f5e890-54b3-4f37-9af1-0a391c0d8c72';
export const chatGPTScrollOptimization = 'sessions.chatgpt.optimizeScrolling';

export class ChatGPTWebContribution extends Disposable implements IWorkbenchContribution {
	public static readonly ID = 'sessions.chatgpt.web';

	constructor(
		@IBrowserViewWorkbenchService private readonly browsers: IBrowserViewWorkbenchService,
		@IBrowserViewService private readonly pages: IBrowserViewService,
		@ISessionsLayoutService private readonly layout: ISessionsLayoutService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this._register(browsers.registerWindowBrowserView(chatGPTBrowserId, { showControls: false }));
		const update = (): void => {
			if (browsers.getKnownBrowserViews().get(chatGPTBrowserId)?.model) {
				void this.updateRendering();
			}
		};
		this._register(browsers.onDidChangeBrowserViews(update));
		this._register(configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(chatGPTScrollOptimization)) { update(); } }));
		this._register(CommandsRegistry.register('sessions.show.chatgpt', (_accessor, source) => this.open(source === 'restore')));
	}

	private async updateRendering(): Promise<void> {
		try {
			await this.pages.setContentVisibility(chatGPTBrowserId, this.configuration.getValue<boolean>(chatGPTScrollOptimization)
				? { origin: `${browserPageScheme}://chatgpt`, selector: '.ash-chatgpt-turn.complete' }
				: undefined);
		} catch {
			// An experimental rendering failure must not prevent opening the chat page.
			if (!this.isDisposed) { this.notifications.error(localize('sessions.chatgpt.optimizationFailed', 'Could not update ChatGPT scrolling optimization.')); }
		}
	}

	private async open(restore: boolean): Promise<void> {
		await this.browsers.initialize();
		if (this.isDisposed) { return; }
		const input = this.browsers.getOrCreateLazy({
			id: chatGPTBrowserId, url: `${browserPageScheme}://chatgpt/browser/chatgpt/chatgpt.html?locale=${encodeURIComponent(getNLSLanguage())}`, title: localize('sessions.chatgpt.title', 'ChatGPT'),
			session: { scope: BrowserViewStorageScope.Global },
		});
		await input.resolve();
		if (this.isDisposed) { return; }
		// Retire a restored website tab at the same product entry; do not keep two chat implementations.
		if (input.model && !input.model.state.url.startsWith(`${browserPageScheme}://chatgpt/`)) {
			await input.model.loadURL(`${browserPageScheme}://chatgpt/browser/chatgpt/chatgpt.html?locale=${encodeURIComponent(getNLSLanguage())}`);
		}
		await this.updateRendering();
		await this.layout.openEntry({
			id: 'chatgpt', activityContext: 'sessions.activity.chatgptSelected', content: 'editor',
			showEditorTabs: false,
			editorInput: input, restoreCommand: 'sessions.show.chatgpt', focus: 'editor',
		}, undefined, restore ? { source: 'restore' } : undefined);
	}
}
