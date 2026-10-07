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
		label: 'General',
		description: 'Configure core application behavior and accessibility.',
		categories: [
			{
				id: 'general',
				label: 'Application',
				description: 'Configure core application behavior and accessibility.',
				presentation: 'general',
				groups: [
					{
						id: 'display-language',
						get label() { return localize({ bundle: 'ash.settings', key: 'displayLanguage.title' }, 'Display Language'); },
						get description() { return localize({ bundle: 'ash.settings', key: 'displayLanguage.description' }, 'Choose the language used by the Ash interface.'); },
						settings: ['workbench.locale'],
					},
					{
						id: 'updates',
						get label() { return localize('update.settingsGroup', 'Updates'); },
						get description() { return localize('update.settingsGroupDescription', 'Choose how Ash Desktop checks for product updates.'); },
						settings: ['update.policy'],
					},
					{
						id: 'source-control',
						get label() { return localize('git.settings.group', 'Source Control'); },
						get description() { return localize('git.settings.groupDescription', 'Configure Git fetching and Source Control diff decorations.'); },
						settings: ['git.autofetch', 'git.autofetchPeriod', 'scm.diffDecorationsIgnoreTrimWhitespace'],
					},
					{
						id: 'url-opening',
						get label() { return localize('externalUriOpener.settings.group', 'Links'); },
						get description() { return localize('externalUriOpener.settings.groupDescription', 'Choose where website links open.'); },
						settings: ['workbench.externalUriOpeners'],
					},
					{
						id: 'accessibility',
						label: 'Accessibility',
						description: 'Adjust screen-reader behavior, motion, transparency, and link visibility.',
						settings: ['accessibility.*', 'editor.accessibilitySupport', 'workbench.reduceMotion', 'workbench.reduceTransparency'],
					},
					{
						id: 'interaction',
						label: 'Interaction',
						description: 'Tune hover feedback and resize handles.',
						settings: ['workbench.hover.*', 'workbench.sash.*', 'onboarding.enabled'],
					},
					{
						id: 'dictation',
						get label() { return localize('settings.dictation.group', 'Voice input'); },
						get description() { return localize('settings.dictation.groupDescription', 'Choose how voice input is transcribed.'); },
						settings: ['dictation.*'],
					},
				],
			},
			{
				id: 'github',
				label: 'GitHub',
				description: 'Connect accounts and manage Codex pull request reviews.',
				keywords: ['Codex', 'PR', 'review', 'Connector'],
				presentation: 'general',
				groups: [],
			},
			{
				id: 'network',
				label: 'Network',
				description: 'Configure application HTTP compatibility and check service connectivity.',
				keywords: ['proxy', 'VPN', 'HTTP', 'domains', 'connectivity'],
				presentation: 'general',
				groups: [],
			},
		],
	},
	{
		id: 'workbench',
		label: 'Workbench',
		description: 'Configure the Workbench appearance, layout, and startup.',
		categories: [
			{
				id: 'appearance',
				label: 'Appearance',
				description: 'Customize the visual appearance of Ash.',
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
					get label() { return localize('settings.workbench.editorTips.label', 'Editor tips'); },
					get description() { return localize('workbench.tips.enabled.description', 'Show command shortcuts when no editor is open.'); },
					settings: ['workbench.tips.enabled'],
				}],
			},
			{
				id: 'layout',
				label: 'Layout',
				description: 'Choose the arrangement of Workbench areas and window zoom.',
				presentation: 'general',
				groups: [{
					id: 'layout',
					get label() { return localize('settings.workbench.layout.group.label', 'Workbench layout'); },
					get description() { return localize('settings.workbench.layout.description', 'Configure the Workbench layout and window zoom.'); },
					settings: ['workbench.layoutStyle', 'workbench.activityBar.location', 'workbench.activityBar.badges', 'workbench.activityBar.compact', 'workbench.sideBar.location', 'window.title', 'window.titleSeparator', 'window.titleBarStyle', 'window.menuStyle', 'window.zoomLevel', 'workbench.tree.*', 'workbench.list.smoothScrolling'],
				}],
			},
			{
				id: 'startup',
				label: 'Startup',
				description: 'Choose what Ash shows when a window opens.',
				presentation: 'general',
				groups: [{
					id: 'startup-windows',
					get label() { return localize('settings.workbench.startup.windows.label', 'Startup windows'); },
					get description() { return localize('settings.workbench.startup.windows.description', 'Choose which windows Ash reopens.'); },
					settings: ['window.restoreWindows', 'window.newWindowDimensions', 'window.restoreFullscreen'],
				}, {
					id: 'startup-editor',
					get label() { return localize('settings.workbench.startup.group.label', 'Startup editor'); },
					get description() { return localize('settings.workbench.startup.group.description', 'Choose what appears when no editor is restored.'); },
					settings: ['workbench.startupEditor', 'workbench.editor.restoreEditors'],
				}],
			},
		],
	},
	{
		id: 'editor',
		label: 'Editor',
		description: 'Configure text editing, fonts, search, and diff behavior.',
		categories: [
			{
				id: 'editor-fonts',
				label: 'Fonts and spacing',
				description: 'Configure the font, text size, ligatures, and line spacing.',
				presentation: 'editor',
				groups: [
					{
						id: 'typography',
						get label() { return localize('settings.editor.typography.label', 'Fonts and spacing'); },
						get description() { return localize('settings.editor.typography.description', 'Configure editor fonts and line spacing.'); },
						settings: ['editor.fontFamily', 'editor.fontSize', 'editor.fontLigatures', 'editor.lineHeight'],
					},
				],
			},
			{
				id: 'editor-display',
				label: 'Display',
				description: 'Configure text display, the cursor, navigation aids, and rendering.',
				presentation: 'editor',
				groups: [
					{
						id: 'display',
						get label() { return localize('settings.editor.display.label', 'Text display'); },
						get description() { return localize('settings.editor.display.description', 'Configure line wrapping, guides, highlighting, and navigation aids.'); },
						settings: ['breadcrumbs.*', 'editor.wordWrap', 'editor.wrappingIndent', 'editor.renderWhitespace', 'editor.renderControlCharacters', 'editor.lineNumbers', 'editor.cursorStyle', 'editor.cursorBlinking', 'editor.cursorSmoothCaretAnimation', 'editor.cursorWidth', 'editor.cursorHeight', 'editor.guides.*', 'editor.matchBrackets', 'editor.bracketPairColorization.*', 'editor.stickyScroll.*', 'editor.renderLineHighlight', 'editor.renderLineHighlightOnlyWhenFocus', 'editor.unicodeHighlights'],
					},
					{
						id: 'minimap',
						get label() { return localize('settings.editor.minimap.label', 'Minimap'); },
						get description() { return localize('settings.editor.minimap.description', 'Configure the editor document overview.'); },
						settings: ['editor.minimap.*'],
					},
					{
						id: 'performance',
						get label() { return localize('settings.editor.performance.label', 'Rendering'); },
						get description() { return localize('settings.editor.performance.description', 'Configure editor rendering performance.'); },
						settings: ['editor.experimentalGpuAcceleration'],
					},
				],
			},
			{
				id: 'editor-editing',
				label: 'Editing',
				description: 'Configure indentation and formatting.',
				presentation: 'editor',
				groups: [
					{
						id: 'editing',
						get label() { return localize('settings.editor.editing.label', 'Indentation and formatting'); },
						get description() { return localize('settings.editor.editing.description', 'Configure indentation and save-time formatting.'); },
						settings: ['editor.indentation', 'editor.tabSize', 'editor.formatOnSave'],
					},
				],
			},
			{
				id: 'editor-suggestions',
				label: 'Completions and hints',
				description: 'Configure code completions, inline suggestions, and hints.',
				presentation: 'editor',
				groups: [
					{
						id: 'code-intelligence',
						get label() { return localize('settings.editor.code-intelligence.label', 'Completions and hints'); },
						get description() { return localize('settings.editor.code-intelligence.description', 'Configure completions, hints, and provider annotations.'); },
						settings: ['editor.suggest.*', 'editor.inlineSuggest.*', 'editor.parameterHints.*', 'editor.inlayHints.*', 'editor.codeLens', 'editor.colorDecorators', 'editor.colorDecoratorsActivatedOn', 'editor.colorDecoratorsLimit', 'editor.defaultColorDecorators'],
					},
				],
			},
			{
				id: 'editor-language',
				label: 'Language servers',
				description: 'Configure language servers and inspect their logs.',
				presentation: 'editor',
				groups: [],
			},
			{
				id: 'editor-search',
				label: 'Search and replace',
				description: 'Configure searches in the current file and across the workspace.',
				presentation: 'editor',
				groups: [
					{
						id: 'find',
						get label() { return localize('settings.editor.find.label', 'Current file'); },
						get description() { return localize('settings.editor.find.description', 'Set defaults for searches inside the active editor.'); },
						settings: ['editor.find.*'],
					},
					{
						id: 'content-search',
						get label() { return localize('settings.editor.content-search.label', 'Workspace search'); },
						get description() { return localize('settings.editor.content-search.description', 'Set defaults for searches across workspace files.'); },
						settings: ['search.*'],
					},
				],
			},
			{
				id: 'editor-diff',
				label: 'Diff editor',
				description: 'Configure how differences are displayed and navigated.',
				presentation: 'editor',
				groups: [
					{
						id: 'diff',
						get label() { return localize('settings.editor.diff.label', 'Diff display'); },
						get description() { return localize('settings.editor.diff.description', 'Configure how differences are displayed and navigated.'); },
						settings: ['diffEditor.*'],
					},
				],
			},
			{
				id: 'editor-opening',
				label: 'Tabs and file opening',
				description: 'Configure editor tabs, file opening, and opening confirmations.',
				presentation: 'editor',
				groups: [
					{
						id: 'file-opening',
						get label() { return localize('settings.editor.fileOpening.label', 'File opening'); },
						get description() { return localize('settings.editor.fileOpening.description', 'Choose how files open and how opening failures are reported.'); },
						settings: ['workbench.editor.openErrorDialog', 'workbench.editor.defaultBinaryEditor', 'workbench.editorLargeFileConfirmation'],
					},
					{
						id: 'selection',
						get label() { return localize('settings.editor.selection.label', 'Tabs and editors'); },
						get description() { return localize('settings.editor.selection.description', 'Choose tab appearance and how documents open.'); },
						settings: ['workbench.editor.*', 'workbench.experimental.modernUIEditorTabStyle'],
					},
				],
			},
			{
				id: 'editor-files',
				label: 'Files and saving',
				description: 'Configure file saving, encoding, and Explorer file nesting.',
				presentation: 'editor',
				groups: [
					{
						id: 'files',
						get label() { return localize('settings.editor.files.label', 'Files and saving'); },
						get description() { return localize('settings.editor.files.description', 'Configure file editing and save behavior.'); },
						settings: ['files.*', 'explorer.fileNesting.*', 'explorer.autoReveal', 'explorer.autoRevealExclude', 'workbench.localHistory.*'],
					},
				],
			},
		],
	},
	{
		id: 'agents',
		label: 'Chat',
		description: 'Configure chats, agents, models, and shared capabilities.',
		categories: [
			{
				id: 'chat-input',
				label: 'Message input',
				description: 'Set the font and spacing for messages you type.',
				keywords: ['chat input', 'prompt', 'font', 'typography'],
				presentation: 'general',
				groups: [{
					id: 'chat-input-typography',
					get label() { return localize('settings.chatInput.label', 'Message input'); },
					get description() { return localize('settings.chatInput.description', 'Choose a font, text size, and line spacing for the message input.'); },
					settings: ['chat.input.fontFamily', 'chat.input.fontSize', 'chat.input.lineHeight'],
				}],
			},
			{
				id: 'chat-code-blocks',
				label: 'Code blocks',
				description: 'Set the font, spacing, and word wrap for code blocks in replies.',
				keywords: ['chat code', 'font', 'typography', 'word wrap'],
				presentation: 'general',
				groups: [{
					id: 'chat-code-blocks',
					get label() { return localize('settings.chatCodeBlocks.label', 'Code blocks'); },
					get description() { return localize('settings.chatCodeBlocks.description', 'Choose how code blocks in replies are displayed.'); },
					settings: ['chat.editor.fontFamily', 'chat.editor.fontSize', 'chat.editor.lineHeight', 'chat.editor.wordWrap'],
				}],
			},
			{
				id: 'agents',
				label: 'Agents',
				description: 'Configure agents and the Advisor used for second opinions.',
				keywords: ['agent profiles', 'custom agents', 'subagents', 'delegation', 'advisor', 'second opinion'],
				presentation: 'general',
				groups: [],
			},
			{
				id: 'teams',
				label: 'Teams',
				description: 'Compose reusable multi-agent teams with explicit members, roles, and coordination.',
				keywords: ['multi-agent', 'team mode', 'members', 'roles', 'coordination'],
				presentation: 'general',
				groups: [],
			},
			{
				id: 'agent-defaults',
				label: 'Defaults',
				description: 'Choose the default agent and shared execution behavior.',
				keywords: ['default agent', 'default team', 'execution'],
				presentation: 'general',
				groups: [{
					id: 'chat-editing',
					get label() { return localize('settings.chatEditing.label', 'Editing'); },
					get description() { return localize('settings.chatEditing.description', 'Choose how Agent edits are reviewed.'); },
					settings: ['chat.editing.autoAcceptDelay'],
				}],
			},
			{
				id: 'models',
				label: 'Models',
				description: 'Choose models and configure model-specific behavior.',
				keywords: ['model providers', 'inference'],
				presentation: 'general',
				groups: [{
					id: 'chat-default',
					get label() { return localize('settings.models.chatDefault.label', 'Chat'); },
					get description() { return localize('settings.models.chatDefault.description', 'Choose the model used for new chats.'); },
					settings: ['chat.defaultModel'],
				}],
			},
			{
				id: 'rules',
				label: 'Rules',
				description: 'Configure the instructions and rules agents follow.',
				keywords: ['instructions', 'agent rules'],
				presentation: 'general',
				groups: [],
			},
			{
				id: 'skills',
				label: 'Skills',
				description: 'Manage reusable skills that agents can activate.',
				keywords: ['agent skills', 'capabilities'],
				presentation: 'general',
				groups: [],
			},
			{
				id: 'tools',
				label: 'Tools',
				description: 'Inspect registered tools and the authority each tool may request.',
				keywords: ['tool catalog', 'tool scope', 'tool permissions', 'mcp', 'model context protocol'],
				presentation: 'general',
				groups: [],
			},
			{
				id: 'sandbox',
				label: 'Sandbox',
				description: 'Inspect process isolation and configured directory grants.',
				keywords: ['isolation', 'directory grants', 'permissions'],
				presentation: 'general',
				groups: [],
			},
			{
				id: 'execution-trace',
				label: 'Execution trace',
				description: 'Manage detailed recording and inspect the running backend configuration.',
				keywords: ['trace', 'requests', 'responses', 'recording', 'diagnostics'],
				presentation: 'general',
				groups: [],
			},
			{
				id: 'hooks',
				label: 'Hooks',
				description: 'Configure automated actions around agent workflow events.',
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
	const remaining = new Map(settings.map(setting => [setting.id, setting]));
	const categories = SettingsCategories.map(category => ({
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
							value: setting,
						},
					};
				}),
			};
		});
	}
}

export function settingsRootNodes(categories: readonly SettingsLayoutCategory[]): readonly SettingsTreeNode<ISetting>[] {
	return SettingsCategories.map(category => ({
		element: {
			kind: 'group',
			id: category.id,
			title: category.label,
			description: category.description,
		},
		children: new SettingsLayout(category.id, categories.find(candidate => candidate.id === category.id)?.groups ?? []).nodes,
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
