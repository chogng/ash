import '../../../services/language/common/languageServerLifecycleService.js';
import type { ISetting, ISettingsGroup, SettingsPresentation } from '../../../services/preferences/common/preferences.js';
import { localize } from '../../../../nls.js';
import type { SettingsTreeNode } from './settingsTreeModels.js';

export interface SettingsGroupDescriptor {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly settings: readonly string[];
}

export interface SettingsCategoryDescriptor {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly keywords?: readonly string[];
	readonly presentation: SettingsPresentation;
	readonly groups: readonly SettingsGroupDescriptor[];
}

export interface SettingsCategoryGroupDescriptor {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly categories: readonly SettingsCategoryDescriptor[];
}

export type SettingsNavigationDescriptor = SettingsCategoryDescriptor | SettingsCategoryGroupDescriptor;

export interface SettingsLayoutCategory {
	readonly descriptor: SettingsCategoryDescriptor;
	readonly id: string;
	readonly groups: readonly ISettingsGroup[];
}

/**
 * The one product-owned Settings layout.
 *
 * Configuration owners declare editable metadata in the Configuration
 * Registry. Preferences owns only where those registered settings appear.
 */
export const SettingsNavigation = [
	{
		id: 'general',
		label: localize({ bundle: 'ash.settings', key: 'groups.general.label' }, 'General'),
		description: localize({ bundle: 'ash.settings', key: 'groups.general.description' }, 'Configure core application behavior.'),
		categories: [
			{
				id: 'general',
				label: localize({ bundle: 'ash.settings', key: 'categories.general.label' }, 'Application'),
				description: localize({ bundle: 'ash.settings', key: 'categories.general.description' }, 'Configure core application behavior.'),
				presentation: 'general',
				groups: [
					{
						id: 'display-language',
						label: localize({ bundle: 'ash.settings', key: 'displayLanguage.title' }, 'Display Language'),
						description: localize({ bundle: 'ash.settings', key: 'displayLanguage.description' }, 'Choose the language used by the Ash interface.'),
						settings: ['workbench.locale'],
					},
					{
						id: 'updates',
						label: localize('update.settingsGroup', 'Updates'),
						description: localize('update.settingsGroupDescription', 'Choose how Ash checks for updates and synchronizes language packs.'),
						settings: ['update.policy', 'network.meteredConnection'],
					},
					{
						id: 'interaction',
						label: 'Interaction',
						description: 'Tune hover feedback and resize handles.',
						settings: ['workbench.hover.*', 'workbench.sash.*', 'workbench.commandPalette.history', 'onboarding.enabled', 'output.smartScroll.enabled', 'chat.disableAIFeatures', 'sessions.automations.notifyOnSuccess', 'task.allowAutomaticTasks'],
					},
				],
			},
			{
				id: 'github',
				label: localize({ bundle: 'ash.settings', key: 'categories.github.label' }, 'GitHub'),
				description: localize({ bundle: 'ash.settings', key: 'categories.github.description' }, 'Connect accounts and manage Codex pull request reviews.'),
				keywords: ['Codex', 'PR', 'review', 'Connector'],
				presentation: 'general',
				groups: [{
					id: 'repository',
					label: localize({ bundle: 'ash.settings', key: 'github.repository.label' }, 'Repositories'),
					description: localize({ bundle: 'ash.settings', key: 'github.repository.description' }, 'Choose the Git protocol and protected branch behavior.'),
					settings: ['github.gitProtocol', 'github.branchProtection'],
				}],
			},
			{
				id: 'network',
				label: localize({ bundle: 'ash.settings', key: 'categories.network.label' }, 'Network'),
				description: localize({ bundle: 'ash.settings', key: 'categories.network.description' }, 'Configure application HTTP compatibility and check service connectivity.'),
				keywords: ['proxy', 'VPN', 'HTTP', 'domains', 'connectivity'],
				presentation: 'general',
				groups: [],
			},
		],
	},
	{
		id: 'workbench',
		label: localize({ bundle: 'ash.settings', key: 'groups.workbench.label' }, 'Workbench'),
		description: localize({ bundle: 'ash.settings', key: 'groups.workbench.description' }, 'Configure the Workbench appearance, layout, and startup.'),
		categories: [
			{
				id: 'appearance',
				label: localize({ bundle: 'ash.settings', key: 'categories.appearance.label' }, 'Appearance'),
				description: localize({ bundle: 'ash.settings', key: 'categories.appearance.description' }, 'Customize the visual appearance of Ash.'),
				presentation: 'general',
				groups: [{
					id: 'theme',
					label: 'Color theme',
					description: 'Choose the colors used by the Workbench.',
					settings: [
						'workbench.colorTheme',
						'workbench.colorCustomizations',
						'editor.tokenColorCustomizations',
						'editor.semanticTokenColorCustomizations',
						'window.autoDetectColorScheme',
						'window.autoDetectHighContrast',
						'workbench.preferredDarkColorTheme',
						'workbench.preferredLightColorTheme',
						'workbench.preferredHighContrastColorTheme',
						'workbench.preferredHighContrastLightColorTheme',
						'workbench.iconTheme',
						'workbench.productIconTheme',
					],
				}, {
					id: 'editor-tips',
					label: localize('settings.workbench.editorTips.label', 'Editor tips'),
					description: localize('workbench.tips.enabled.description', 'Show command shortcuts when no editor is open.'),
					settings: ['workbench.tips.enabled'],
				}],
			},
			{
				id: 'layout',
				label: localize({ bundle: 'ash.settings', key: 'categories.layout.label' }, 'Layout'),
				description: localize({ bundle: 'ash.settings', key: 'categories.layout.description' }, 'Choose the arrangement of Workbench areas and window zoom.'),
				presentation: 'general',
				groups: [{
					id: 'layout',
					label: localize('settings.workbench.layout.group.label', 'Workbench layout'),
					description: localize('settings.workbench.layout.description', 'Configure the Workbench layout and window zoom.'),
					settings: ['workbench.layoutStyle', 'workbench.activityBar.location', 'workbench.activityBar.autoHide', 'workbench.activityBar.badges', 'workbench.activityBar.compact', 'workbench.sideBar.location', 'security.workspace.trust.banner', 'workbench.panel.defaultLocation', 'workbench.statusBar.visible', 'workbench.notifications.position', 'workbench.notifications.showInTitleBar', 'workbench.view.alwaysShowHeaderActions', 'chat.viewSessions.orientation', 'chat.experimental.sessionArchiveActionWording', 'window.title', 'window.titleSeparator', 'window.titleBarStyle', 'window.menuStyle', 'window.zoomLevel', 'window.zoomPerWindow', 'workbench.tree.*', 'workbench.list.smoothScrolling'],
				}],
			},
			{
				id: 'debugging',
				label: localize('settings.debugging.label', 'Debugging'),
				description: localize('settings.debugging.description', 'Configure breakpoints, inline values and confirmation when closing a debug session.'),
				presentation: 'general',
				groups: [{
					id: 'debugging',
					label: localize('settings.debugging.label', 'Debugging'),
					description: localize('settings.debugging.description', 'Configure breakpoints, inline values and confirmation when closing a debug session.'),
					settings: ['debug.allowBreakpointsEverywhere', 'debug.confirmOnExit', 'debug.inlineValues'],
				}],
			},
			{
				id: 'settings-editor',
				label: localize({ bundle: 'ash.settings', key: 'categories.settings-editor.label' }, 'Settings Editor'),
				description: localize({ bundle: 'ash.settings', key: 'categories.settings-editor.description' }, 'Configure how Ash opens and edits settings.'),
				presentation: 'general',
				groups: [{
					id: 'settings-editor',
					label: localize({ bundle: 'ash.settings', key: 'categories.settings-editor.label' }, 'Settings Editor'),
					description: '',
					settings: ['workbench.settings.*'],
				}],
			},
			{
				id: 'startup',
				label: localize({ bundle: 'ash.settings', key: 'categories.startup.label' }, 'Startup'),
				description: localize({ bundle: 'ash.settings', key: 'categories.startup.description' }, 'Choose what Ash shows when a window opens.'),
				presentation: 'general',
				groups: [{
					id: 'startup-windows',
					label: localize('settings.workbench.startup.windows.label', 'Startup windows'),
					description: localize('settings.workbench.startup.windows.description', 'Choose which windows Ash reopens.'),
					settings: ['window.startupWindow', 'window.restoreWindows', 'window.newWindowDimensions', 'window.restoreFullscreen'],
				}, {
					id: 'startup-editor',
					label: localize('settings.workbench.startup.group.label', 'Startup editor'),
					description: localize('settings.workbench.startup.group.description', 'Choose what appears when no editor is restored.'),
					settings: ['workbench.startupEditor', 'workbench.editor.restoreEditors'],
				}],
			},
			{
				id: 'browser',
				label: localize({ bundle: 'ash.settings', key: 'categories.browser.label' }, 'Browser'),
				description: localize({ bundle: 'ash.settings', key: 'categories.browser.description' }, 'Configure website links and integrated browser pages.'),
				presentation: 'general',
				groups: [
					{
						id: 'url-opening',
						label: localize('externalUriOpener.settings.group', 'Links'),
						description: localize('externalUriOpener.settings.groupDescription', 'Choose where website links open.'),
						settings: ['workbench.externalUriOpeners'],
					},
					{
						id: 'browser-controls',
						label: localize({ bundle: 'ash.settings', key: 'categories.browser.label' }, 'Browser'),
						description: localize({ bundle: 'ash.settings', key: 'browser.controls.description' }, 'Control page zoom, address bar search and reload on local file changes.'),
						settings: ['workbench.browser.searchEngine', 'workbench.browser.pageZoom', 'workbench.browser.autoReloadOnFileChange', 'workbench.browser.dataStorage', 'workbench.browser.openLocalhostLinks', 'workbench.browser.savePasswords', 'workbench.browser.autofillPasswords'],
					},
					{
						id: 'browser-agent',
						label: localize({ bundle: 'ash.settings', key: 'browser.agent.label' }, 'Agent control'),
						description: localize({ bundle: 'ash.settings', key: 'browser.agent.description' }, 'Control browser automation and advanced debugging access.'),
						settings: ['workbench.browser.enableChatTools', 'workbench.browser.enableCDP'],
					},
					{
						id: 'chatgpt',
						label: localize({ bundle: 'ash.settings', key: 'browser.chatgpt.label' }, 'ChatGPT'),
						description: localize({ bundle: 'ash.settings', key: 'browser.chatgpt.description' }, 'Configure the ChatGPT website in this window.'),
						settings: ['sessions.chatgpt.optimizeScrolling'],
					},
				],
			},
		],
	},
	{
		id: 'editor',
		label: localize({ bundle: 'ash.settings', key: 'groups.editor.label' }, 'Editor'),
		description: localize({ bundle: 'ash.settings', key: 'groups.editor.description' }, 'Configure text editing, fonts, search, and diff behavior.'),
		categories: [
			{
				id: 'editor-fonts',
				label: localize({ bundle: 'ash.settings', key: 'categories.editor-fonts.label' }, 'Fonts and spacing'),
				description: localize({ bundle: 'ash.settings', key: 'categories.editor-fonts.description' }, 'Configure the font, text size, ligatures, and line spacing.'),
				presentation: 'editor',
				groups: [
					{
						id: 'typography',
						label: localize('settings.editor.typography.label', 'Fonts and spacing'),
						description: localize('settings.editor.typography.description', 'Configure editor fonts and line spacing.'),
						settings: ['editor.fontFamily', 'editor.fontSize', 'editor.fontLigatures', 'editor.lineHeight'],
					},
				],
			},
			{
				id: 'editor-display',
				label: localize({ bundle: 'ash.settings', key: 'categories.editor-display.label' }, 'Display'),
				description: localize({ bundle: 'ash.settings', key: 'categories.editor-display.description' }, 'Configure text display, the cursor, navigation aids, and rendering.'),
				presentation: 'editor',
				groups: [
					{
						id: 'display',
						label: localize('settings.editor.display.label', 'Text display'),
						description: localize('settings.editor.display.description', 'Configure line wrapping, guides, highlighting, and navigation aids.'),
						settings: ['breadcrumbs.*', 'editor.wordWrap', 'editor.wordWrapColumn', 'editor.wrappingIndent', 'editor.renderWhitespace', 'editor.renderControlCharacters', 'editor.lineNumbers', 'editor.cursorStyle', 'editor.cursorBlinking', 'editor.cursorSmoothCaretAnimation', 'editor.cursorWidth', 'editor.cursorHeight', 'editor.guides.*', 'editor.matchBrackets', 'editor.bracketPairColorization.*', 'editor.stickyScroll.*', 'editor.renderLineHighlight', 'editor.renderLineHighlightOnlyWhenFocus', 'editor.unicodeHighlights'],
					},
					{
						id: 'minimap',
						label: localize('settings.editor.minimap.label', 'Minimap'),
						description: localize('settings.editor.minimap.description', 'Configure the editor document overview.'),
						settings: ['editor.minimap.*'],
					},
					{
						id: 'performance',
						label: localize('settings.editor.performance.label', 'Rendering'),
						description: localize('settings.editor.performance.description', 'Configure editor rendering performance.'),
						settings: ['editor.experimentalGpuAcceleration', 'editor.foldingMaximumRegions'],
					},
				],
			},
			{
				id: 'editor-editing',
				label: localize({ bundle: 'ash.settings', key: 'categories.editor-editing.label' }, 'Editing'),
				description: localize({ bundle: 'ash.settings', key: 'categories.editor-editing.description' }, 'Configure indentation and formatting.'),
				presentation: 'editor',
				groups: [
					{
						id: 'editing',
						label: localize('settings.editor.editing.label', 'Indentation and formatting'),
						description: localize('settings.editor.editing.description', 'Configure indentation and save-time formatting.'),
						settings: ['editor.indentation', 'editor.tabSize', 'editor.formatOnSave', 'editor.formatOnType', 'editor.selectionClipboard'],
					},
				],
			},
			{
				id: 'editor-suggestions',
				label: localize({ bundle: 'ash.settings', key: 'categories.editor-suggestions.label' }, 'Completions and hints'),
				description: localize({ bundle: 'ash.settings', key: 'categories.editor-suggestions.description' }, 'Configure code completions, inline suggestions, and hints.'),
				presentation: 'editor',
				groups: [
					{
						id: 'code-intelligence',
						label: localize('settings.editor.code-intelligence.label', 'Completions and hints'),
						description: localize('settings.editor.code-intelligence.description', 'Configure completions, hints, and provider annotations.'),
						settings: ['editor.suggest.*', 'editor.inlineSuggest.*', 'editor.parameterHints.*', 'editor.inlayHints.*', 'editor.codeLens', 'editor.colorDecorators', 'editor.colorDecoratorsActivatedOn', 'editor.colorDecoratorsLimit', 'editor.defaultColorDecorators'],
					},
				],
			},
			{
				id: 'editor-language',
				label: localize({ bundle: 'ash.settings', key: 'categories.editor-language.label' }, 'Language servers'),
				description: localize({ bundle: 'ash.settings', key: 'categories.editor-language.description' }, 'Configure language servers and inspect their logs.'),
				presentation: 'editor',
				groups: [{
					id: 'language-server-lifecycle',
					label: localize({ bundle: 'ash.settings', key: 'lsp.idle.groupTitle' }, 'Analysis cache and memory'),
					description: localize({ bundle: 'ash.settings', key: 'lsp.idle.groupDescription' }, 'Started servers stay running by default to reuse their in-memory analysis. Rust computes analysis on demand by default. Its analysis cache is lost when the server stops; Cargo build artifacts on disk do not restore this cache.'),
					settings: ['languageServers.autoSuspend', 'languageServers.idleTimeoutMinutes'],
				}],
			},
			{
				id: 'editor-search',
				label: localize({ bundle: 'ash.settings', key: 'categories.editor-search.label' }, 'Search and replace'),
				description: localize({ bundle: 'ash.settings', key: 'categories.editor-search.description' }, 'Configure search and replace in the current file.'),
				presentation: 'editor',
				groups: [
					{
						id: 'find',
						label: localize('settings.editor.find.label', 'Current file'),
						description: localize('settings.editor.find.description', 'Set defaults for searches inside the active editor.'),
						settings: ['editor.find.*'],
					},
				],
			},
			{
				id: 'editor-diff',
				label: localize({ bundle: 'ash.settings', key: 'categories.editor-diff.label' }, 'Diff editor'),
				description: localize({ bundle: 'ash.settings', key: 'categories.editor-diff.description' }, 'Configure how differences are displayed and navigated.'),
				presentation: 'editor',
				groups: [
					{
						id: 'diff',
						label: localize('settings.editor.diff.label', 'Diff display'),
						description: localize('settings.editor.diff.description', 'Configure how differences are displayed and navigated.'),
						settings: ['diffEditor.*'],
					},
				],
			},
			{
				// Claim file-opening choices before the broader workbench.editor.* tab settings.
				id: 'editor-files',
				label: localize({ bundle: 'ash.settings', key: 'categories.editor-files.label' }, 'Files'),
				description: localize({ bundle: 'ash.settings', key: 'categories.editor-files.description' }, 'Configure file visibility, opening, encoding, saving, and local history.'),
				presentation: 'editor',
				groups: [
					{
						id: 'file-opening',
						label: localize('settings.editor.fileOpening.label', 'File opening'),
						description: localize('settings.editor.fileOpening.description', 'Choose how files open and how opening failures are reported.'),
						settings: ['workbench.editor.openErrorDialog', 'workbench.editor.defaultBinaryEditor', 'workbench.editorLargeFileConfirmation', 'workbench.editor.defaultNewDocumentEditor'],
					},
					{
						id: 'files',
						label: localize('settings.editor.files.label', 'Files and saving'),
						description: localize('settings.editor.files.description', 'Configure file editing and save behavior.'),
						settings: ['files.*', 'workbench.localHistory.*', 'debug.saveBeforeStart'],
					},
				],
			},
			{
				id: 'editor-opening',
				label: localize({ bundle: 'ash.settings', key: 'categories.editor-opening.label' }, 'Tabs and editors'),
				description: localize({ bundle: 'ash.settings', key: 'categories.editor-opening.description' }, 'Configure editor tabs, previews, and editor groups.'),
				presentation: 'editor',
				groups: [
					{
						id: 'selection',
						label: localize('settings.editor.selection.label', 'Tabs and editors'),
						description: localize('settings.editor.selection.description', 'Choose tab appearance and how documents open.'),
						settings: ['workbench.editor.*', 'workbench.experimental.modernUIEditorTabStyle'],
					},
				],
			},
		],
	},
	{
		id: 'features',
		label: localize({ bundle: 'ash.settings', key: 'groups.features.label' }, 'Features'),
		description: localize({ bundle: 'ash.settings', key: 'groups.features.description' }, 'Configure individual Workbench features.'),
		categories: [
			{
				id: 'accessibilitySignals',
				label: localize({ bundle: 'ash.settings', key: 'categories.accessibilitySignals.label' }, 'Accessibility Signals'),
				description: localize({ bundle: 'ash.settings', key: 'categories.accessibilitySignals.description' }, 'Configure sounds and announcements for Workbench events.'),
				presentation: 'general',
				groups: [{
					id: 'accessibilitySignals',
					label: localize({ bundle: 'ash.settings', key: 'categories.accessibilitySignals.label' }, 'Accessibility Signals'),
					description: localize({ bundle: 'ash.settings', key: 'categories.accessibilitySignals.description' }, 'Configure sounds and announcements for Workbench events.'),
					// Claim signals and signalOptions before the broader accessibility category.
					settings: ['accessibility.signal*'],
				}],
			},
			{
				id: 'accessibility',
				label: localize({ bundle: 'ash.settings', key: 'categories.accessibility.label' }, 'Accessibility'),
				description: localize({ bundle: 'ash.settings', key: 'categories.accessibility.description' }, 'Configure screen-reader support, accessibility help, motion, transparency, and link visibility.'),
				presentation: 'general',
				groups: [{
					id: 'accessibility',
					label: localize({ bundle: 'ash.settings', key: 'categories.accessibility.label' }, 'Accessibility'),
					description: localize({ bundle: 'ash.settings', key: 'categories.accessibility.description' }, 'Configure screen-reader support, accessibility help, motion, transparency, and link visibility.'),
					settings: ['accessibility.*', 'editor.accessibilitySupport', 'workbench.reduceMotion', 'workbench.reduceTransparency'],
				}],
			},
			{
				id: 'explorer',
				label: localize({ bundle: 'ash.settings', key: 'categories.explorer.label' }, 'Explorer'),
				description: localize({ bundle: 'ash.settings', key: 'categories.explorer.description' }, 'Configure file nesting and automatic file reveal.'),
				presentation: 'general',
				groups: [
					{
						id: 'explorer',
						label: localize({ bundle: 'ash.settings', key: 'categories.explorer.label' }, 'Explorer'),
						description: localize({ bundle: 'ash.settings', key: 'categories.explorer.description' }, 'Configure file nesting and automatic file reveal.'),
						settings: ['explorer.*'],
					},
				],
			},
			{
				id: 'search',
				label: localize({ bundle: 'ash.settings', key: 'categories.search.label' }, 'Search'),
				description: localize({ bundle: 'ash.settings', key: 'categories.search.description' }, 'Configure workspace searches and the content search engine.'),
				presentation: 'general',
				groups: [
					{
						id: 'content-search',
						label: localize('settings.editor.content-search.label', 'Workspace search'),
						description: localize('settings.editor.content-search.description', 'Set defaults for searches across workspace files.'),
						settings: ['search.*'],
					},
				],
			},
			{
				id: 'source-control',
				label: localize({ bundle: 'ash.settings', key: 'categories.source-control.label' }, 'Source Control'),
				description: localize({ bundle: 'ash.settings', key: 'categories.source-control.description' }, 'Configure source control providers and diff decorations.'),
				presentation: 'general',
				groups: [
					{
						id: 'source-control',
						label: localize('scm.settings.group', 'Source Control'),
						description: localize('scm.settings.groupDescription', 'Configure source control providers and diff decorations.'),
						settings: ['scm.diffDecorationsIgnoreTrimWhitespace', 'scm.graph.pageSize', 'scm.graph.pageOnScroll', 'scm.graph.badges', 'scm.graph.showIncomingChanges', 'scm.graph.showOutgoingChanges'],
					},
				],
			},
			{
				id: 'terminal',
				label: localize({ bundle: 'ash.settings', key: 'categories.terminal.label' }, 'Terminal'),
				description: localize({ bundle: 'ash.settings', key: 'categories.terminal.description' }, 'Configure terminal fonts, cursor appearance, contrast, and scrollback.'),
				presentation: 'general',
				groups: [{
					id: 'terminal',
					label: localize({ bundle: 'ash.settings', key: 'categories.terminal.label' }, 'Terminal'),
					description: localize({ bundle: 'ash.settings', key: 'categories.terminal.description' }, 'Configure terminal fonts, cursor appearance, contrast, and scrollback.'),
					settings: ['terminal.integrated.*'],
				}],
			},
			{
				id: 'voice-input',
				label: localize({ bundle: 'ash.settings', key: 'categories.voice-input.label' }, 'Voice input'),
				description: localize({ bundle: 'ash.settings', key: 'categories.voice-input.description' }, 'Choose local or cloud transcription and manage dictation models.'),
				keywords: ['dictation', 'speech', 'transcription'],
				presentation: 'general',
				groups: [
					{
						id: 'dictation',
						label: localize('settings.dictation.group', 'Voice input'),
						description: localize('settings.dictation.groupDescription', 'Choose how voice input is transcribed.'),
						settings: ['dictation.*'],
					},
				],
			},
		],
	},
	{
		id: 'agents',
		label: localize({ bundle: 'ash.settings', key: 'groups.agents.label' }, 'Chat'),
		description: localize({ bundle: 'ash.settings', key: 'groups.agents.description' }, 'Configure chats, agents, models, and shared capabilities.'),
		categories: [
			{
				id: 'chat-input',
				label: localize({ bundle: 'ash.settings', key: 'categories.chat-input.label' }, 'Message input'),
				description: localize({ bundle: 'ash.settings', key: 'categories.chat-input.description' }, 'Set the font and spacing for messages you type.'),
				keywords: ['chat input', 'prompt', 'font', 'typography'],
				presentation: 'general',
				groups: [{
					id: 'chat-input-typography',
					label: localize('settings.chatInput.label', 'Message input'),
					description: localize('settings.chatInput.description', 'Choose a font, text size, and line spacing for the message input.'),
					settings: ['chat.input.fontFamily', 'chat.input.fontSize', 'chat.input.lineHeight'],
				}],
			},
			{
				id: 'chat-code-blocks',
				label: localize({ bundle: 'ash.settings', key: 'categories.chat-code-blocks.label' }, 'Code blocks'),
				description: localize({ bundle: 'ash.settings', key: 'categories.chat-code-blocks.description' }, 'Set the font, spacing, and word wrap for code blocks in replies.'),
				keywords: ['chat code', 'font', 'typography', 'word wrap'],
				presentation: 'general',
				groups: [{
					id: 'chat-code-blocks',
					label: localize('settings.chatCodeBlocks.label', 'Code blocks'),
					description: localize('settings.chatCodeBlocks.description', 'Choose how code blocks in replies are displayed.'),
					settings: ['chat.editor.fontFamily', 'chat.editor.fontSize', 'chat.editor.lineHeight', 'chat.editor.wordWrap'],
				}],
			},
			{
				id: 'agents',
				label: localize({ bundle: 'ash.settings', key: 'categories.agents.label' }, 'Agents'),
				description: localize({ bundle: 'ash.settings', key: 'categories.agents.description' }, 'Configure agents and the Advisor used for second opinions.'),
				keywords: ['agent profiles', 'custom agents', 'subagents', 'delegation', 'advisor', 'second opinion'],
				presentation: 'general',
				groups: [],
			},
			{
				id: 'teams',
				label: localize({ bundle: 'ash.settings', key: 'categories.teams.label' }, 'Teams'),
				description: localize({ bundle: 'ash.settings', key: 'categories.teams.description' }, 'Compose reusable multi-agent teams with explicit members, roles, and coordination.'),
				keywords: ['multi-agent', 'team mode', 'members', 'roles', 'coordination'],
				presentation: 'general',
				groups: [],
			},
			{
				id: 'agent-defaults',
				label: localize({ bundle: 'ash.settings', key: 'categories.agent-defaults.label' }, 'Defaults'),
				description: localize({ bundle: 'ash.settings', key: 'categories.agent-defaults.description' }, 'Choose the default agent and shared execution behavior.'),
				keywords: ['default agent', 'default team', 'execution'],
				presentation: 'general',
				groups: [{
					id: 'chat-editing',
					label: localize('settings.chatEditing.label', 'Editing'),
					description: localize('settings.chatEditing.description', 'Choose how Agent edits are reviewed.'),
					settings: ['chat.editing.autoAcceptDelay'],
				}, {
					id: 'customization-discovery',
					label: localize({ bundle: 'ash.extensions', key: 'marketplaceEnabledTitle' }, 'Discover skills and connections'),
					description: localize({ bundle: 'ash.extensions', key: 'marketplaceEnabledDescription' }, 'Show catalog results in Skills and Connections within Extensions. Installed resources remain available.'),
					settings: ['chat.customizations.marketplace.enabled'],
				}],
			},
			{
				id: 'models',
				label: localize({ bundle: 'ash.settings', key: 'categories.models.label' }, 'Models'),
				description: localize({ bundle: 'ash.settings', key: 'categories.models.description' }, 'Choose models and configure model-specific behavior.'),
				keywords: ['model providers', 'inference'],
				presentation: 'general',
				groups: [{
					id: 'chat-default',
					label: localize('settings.models.chatDefault.label', 'Chat'),
					description: localize('settings.models.chatDefault.description', 'Choose the model used for new chats.'),
					settings: ['chat.defaultModel', 'cowork.defaultmodel'],
				}],
			},
			{
				id: 'rules',
				label: localize({ bundle: 'ash.settings', key: 'categories.rules.label' }, 'Rules'),
				description: localize({ bundle: 'ash.settings', key: 'categories.rules.description' }, 'Configure the instructions and rules agents follow.'),
				keywords: ['instructions', 'agent rules'],
				presentation: 'general',
				groups: [],
			},
			{
				id: 'sandbox',
				label: localize({ bundle: 'ash.settings', key: 'categories.sandbox.label' }, 'Sandbox'),
				description: localize({ bundle: 'ash.settings', key: 'categories.sandbox.description' }, 'Configure Agent command access and inspect effective isolation and directory grants.'),
				keywords: ['isolation', 'directory grants', 'permissions'],
				presentation: 'general',
				groups: [],
			},
			{
				id: 'execution-trace',
				label: localize({ bundle: 'ash.settings', key: 'categories.execution-trace.label' }, 'Execution trace'),
				description: localize({ bundle: 'ash.settings', key: 'categories.execution-trace.description' }, 'Manage detailed recording and inspect the running backend configuration.'),
				keywords: ['trace', 'requests', 'responses', 'recording', 'diagnostics'],
				presentation: 'general',
				groups: [],
			},
			{
				id: 'hooks',
				label: localize({ bundle: 'ash.settings', key: 'categories.hooks.label' }, 'Hooks'),
				description: localize({ bundle: 'ash.settings', key: 'categories.hooks.description' }, 'Configure automated actions around agent workflow events.'),
				keywords: ['automation', 'workflow hooks'],
				presentation: 'general',
				groups: [],
			},
		],
	},
] as const satisfies readonly SettingsNavigationDescriptor[];

export const SettingsCategories: readonly SettingsCategoryDescriptor[] = SettingsNavigation
	.flatMap<SettingsCategoryDescriptor>(entry => 'categories' in entry ? entry.categories : [entry]);

/** Projects registered configuration settings through the canonical layout. */
export function createSettingsLayout(settings: readonly ISetting[]): readonly SettingsLayoutCategory[] {
	const remaining = new Map(settings.filter(setting => !setting.configuration.source).map(setting => [setting.id, setting]));
	const categories: SettingsLayoutCategory[] = SettingsCategories.map(category => ({
		descriptor: category,
		id: category.id,
		groups: category.groups.map(group => {
			const matches = [...remaining.values()].filter(setting => group.settings.some(pattern => matchesSettingId(setting.id, pattern)));
			for (const setting of matches) remaining.delete(setting.id);
			return {
				id: group.id,
				title: group.label,
				description: group.description,
				settings: matches.map(setting => ({ ...setting, presentation: category.presentation })),
			};
		}).filter(group => group.settings.length > 0),
	}));

	if (remaining.size > 0) {
		const ids = [...remaining.keys()].sort().join(', ');
		throw new Error(`Registered settings are missing from settingsLayout.ts: ${ids}`);
	}
	const extensions = new Map<string, ISetting[]>();
	for (const setting of settings) {
		const source = setting.configuration.source;
		if (!source) continue;
		const entries = extensions.get(source.id) ?? [];
		entries.push(setting);
		extensions.set(source.id, entries);
	}
	for (const [id, entries] of extensions) {
		const source = entries[0].configuration.source!;
		const label = source.displayName ?? id;
		const descriptor: SettingsCategoryDescriptor = {
			id: `extension.${id}`,
			label,
			description: '',
			keywords: [id],
			presentation: 'general',
			groups: [],
		};
		categories.push({
			id: descriptor.id,
			descriptor,
			groups: [{ id: 'settings', title: label, description: '', settings: entries.map(setting => ({ ...setting, presentation: descriptor.presentation })) }],
		});
	}
	return categories;
}

/** Projects declarative groups into a validated tree with stable Settings IDs. */
export class SettingsLayout {
	public readonly nodes: readonly SettingsTreeNode<ISetting>[];

	constructor(tocId: string, groups: readonly ISettingsGroup[]) {
		assertSettingsLayoutId('TOC ID', tocId);
		const nodeIds = new Set<string>();
		this.nodes = groups.map(group => {
			assertSettingsLayoutId('group ID', group.id);
			assertSettingsLayoutText(`group '${group.id}' title`, group.title);
			const groupId = `${tocId}.group.${group.id}`;
			addSettingsLayoutId(nodeIds, groupId, 'group');
			return {
				element: {
					kind: 'group',
					id: groupId,
					title: group.title,
					description: group.description,
				},
				children: group.settings.map(setting => {
					assertSettingsLayoutId('setting ID', setting.id);
					assertSettingsLayoutText(`setting '${setting.id}' title`, setting.title);
					addSettingsLayoutId(nodeIds, setting.id, 'setting');
					return {
						element: {
							kind: 'item',
							id: setting.id,
							title: setting.title,
							description: setting.description,
							keywords: [setting.id, ...(setting.keywords ?? [])],
							tags: setting.tags,
							value: setting,
						},
					};
				}),
			};
		});
	}
}

export function settingsRootNodes(categories: readonly SettingsLayoutCategory[]): readonly SettingsTreeNode<ISetting>[] {
	return categories.map(category => ({
		element: {
			kind: 'group',
			id: category.id,
			title: category.descriptor.label,
			description: category.descriptor.description,
		},
		children: new SettingsLayout(category.id, category.groups).nodes,
	}));
}

function assertSettingsLayoutText(label: string, value: string): void {
	if (!value.trim()) throw new TypeError(`Settings layout ${label} must not be empty`);
}

function matchesSettingId(settingId: string, pattern: string): boolean {
	const source = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*');
	return new RegExp(`^${source}$`, 'u').test(settingId);
}

function assertSettingsLayoutId(label: string, value: string): void {
	assertSettingsLayoutText(label, value);
	if (/\p{Cc}/u.test(value)) throw new TypeError(`Settings layout ${label} must not contain control characters`);
}

function addSettingsLayoutId(ids: Set<string>, id: string, kind: 'group' | 'setting'): void {
	if (ids.has(id)) throw new TypeError(`Duplicate Settings ${kind} ID '${id}'`);
	ids.add(id);
}
