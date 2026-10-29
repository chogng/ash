import { Disposable } from '../../../../base/common/lifecycle.js';
import { derived } from '../../../../base/common/observable.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import type { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';
import { IChatGPTService, chatGPTNavigationContainerId } from './chatGPTService.js';
import { ISessionsSearchService } from '../../search/browser/searchService.js';
import type { SearchResult } from '../../search/browser/searchModel.js';

export const chatGPTScrollOptimization = 'sessions.chatgpt.optimizeScrolling';

export class ChatGPTWebContribution extends Disposable implements IWorkbenchContribution {
	public static readonly ID = 'sessions.chatgpt.web';
	constructor(
		@ISessionsLayoutService layout: ISessionsLayoutService,
		@IChatGPTService chat: IChatGPTService,
		@ISessionsSearchService search: ISessionsSearchService,
		@IEditorService editors: IEditorService,
	) {
		super();
		const showChat = (source?: unknown) => {
			chat.initialize();
			return layout.openEntry(
				{
					id: 'chatgpt',
					activityContext: 'sessions.activity.chatgptSelected',
					content: 'editor',
					sidebarContainerId: chatGPTNavigationContainerId,
					showEditorTabs: false,
					editorInput: {
						resource: URI.from({ scheme: 'ash-chatgpt', path: '/page' }),
						label: localize('sessions.chatgpt.title', 'ChatGPT'),
						showBreadcrumbs: false,
						readOnly: true,
						capabilities: EditorInputCapabilities.CannotClose,
					},
					restoreCommand: 'sessions.show.chatgpt',
					newSessionCommand: 'sessions.chatgpt.newChat',
					focus: 'editor',
				},
				undefined,
				source === 'restore' ? { source } : undefined,
			);
		};
		this._register(
			search.registerSource(
				derived<readonly SearchResult[]>(reader => {
					const state = chat.state.read(reader);
					return state.conversations.map(conversation => ({
						id: `chatgpt:${conversation.id}`,
						category: 'sessions',
						title: conversation.title,
						description: ['ChatGPT', state.projects.find(project => project.id === conversation.projectId)?.title].filter(Boolean).join(' · '),
						icon: Lxicon.openai,
						target: {
							kind: 'contributed',
							open: async () => {
								await showChat();
								await chat.select(conversation.id);
								editors.focusActiveEditor();
							},
						},
					}));
				}),
			),
		);
		const newChat = () => {
			chat.newChat();
			editors.focusActiveEditor();
		};
		this._register(CommandsRegistry.register('sessions.chatgpt.newChat', newChat));
		this._register(CommandsRegistry.register('sessions.show.chatgpt', (_accessor, source) => showChat(source)));
		this._register(
			CommandsRegistry.register('sessions.open.new', async (_accessor, source) => {
				if (source !== 'restore') {
					chat.newChat();
				}
				await showChat(source);
			}),
		);
		// Saved window entries and existing keybindings from the experiment retain the same chat owner.
		this._register(CommandsRegistry.register('sessions.chatgptNative.newChat', newChat));
		for (const command of ['sessions.show.chatgptNative', 'sessions.open.chatgptNative']) {
			this._register(CommandsRegistry.register(command, (_accessor, source) => showChat(source)));
		}
	}
}
