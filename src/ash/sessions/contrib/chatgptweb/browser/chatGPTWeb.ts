import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import type { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';
import { IChatGPTService, chatGPTNavigationContainerId } from './chatGPTService.js';

export const chatGPTScrollOptimization = 'sessions.chatgpt.optimizeScrolling';

export class ChatGPTWebContribution extends Disposable implements IWorkbenchContribution {
	public static readonly ID = 'sessions.chatgpt.web';
	constructor(@ISessionsLayoutService layout: ISessionsLayoutService, @IChatGPTService chat: IChatGPTService) {
		super();
		this._register(CommandsRegistry.register('sessions.show.chatgpt', (_accessor, source) => {
			chat.initialize();
			return layout.openEntry({
				id: 'chatgpt', activityContext: 'sessions.activity.chatgptSelected', content: 'editor',
				sidebarContainerId: chatGPTNavigationContainerId, showEditorTabs: false,
				editorInput: {
					resource: URI.from({ scheme: 'ash-chatgpt', path: '/page' }), label: localize('sessions.chatgpt.title', 'ChatGPT'),
					showBreadcrumbs: false, readOnly: true, capabilities: EditorInputCapabilities.CannotClose,
				},
				restoreCommand: 'sessions.show.chatgpt', focus: 'editor',
			}, undefined, source === 'restore' ? { source } : undefined);
		}));
	}
}
