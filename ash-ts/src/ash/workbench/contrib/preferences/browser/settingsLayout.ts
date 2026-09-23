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
		presentation: 'general',
		groups: [
			{
				id: 'source-control',
				get label() { return localize('git.settings.group', 'Source Control'); },
				get description() { return localize('git.settings.groupDescription', 'Configure how Git checks for remote updates.'); },
				settings: ['git.autofetch', 'git.autofetchPeriod'],
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
				settings: ['workbench.hover.*', 'workbench.sash.*'],
			},
		],
	},
	{
		id: 'appearance',
		label: 'Appearance',
		description: 'Customize the visual appearance of Ash.',
		presentation: 'general',
		groups: [
			{
				id: 'theme',
				label: 'Color theme',
				description: 'Choose the colors used by the Workbench.',
				settings: ['workbench.colorTheme', 'workbench.iconTheme'],
			},
			{
				id: 'layout',
				label: 'Layout',
				description: 'Choose how Workbench regions connect to each other.',
				settings: ['workbench.layoutStyle'],
			},
		],
	},
	{
		id: 'editor',
		label: 'Editor',
		description: 'Configure text editing, fonts, search, and diff behavior.',
		presentation: 'editor',
		groups: [
			{
				id: 'selection',
				label: 'Editor selection',
				description: 'Choose which editor opens for new documents.',
				settings: ['workbench.editor.*'],
			},
			{
				id: 'typography',
				label: 'Typography',
				description: 'Configure editor fonts and line spacing.',
				settings: ['editor.fontFamily', 'editor.fontSize', 'editor.fontLigatures', 'editor.lineHeight'],
			},
			{
				id: 'display',
				label: 'Display',
				description: 'Configure line wrapping, guides, highlighting, and scrolling aids.',
				settings: ['breadcrumbs.enabled', 'editor.wordWrap', 'editor.wrappingIndent', 'editor.lineNumbers', 'editor.cursorStyle', 'editor.cursorBlinking', 'editor.cursorSmoothCaretAnimation', 'editor.cursorWidth', 'editor.cursorHeight', 'editor.guides.*', 'editor.matchBrackets', 'editor.bracketPairColorization.*', 'editor.stickyScroll.*', 'editor.renderLineHighlight', 'editor.renderLineHighlightOnlyWhenFocus', 'editor.unicodeHighlights'],
			},
			{
				id: 'performance',
				label: 'Performance',
				description: 'Configure editor rendering performance.',
				settings: ['editor.experimentalGpuAcceleration'],
			},
			{
				id: 'minimap',
				label: 'Minimap',
				description: 'Configure the editor document overview.',
				settings: ['editor.minimap.*'],
			},
			{
				id: 'editing',
				label: 'Editing',
				description: 'Configure indentation and save-time editing behavior.',
				settings: ['editor.indentation', 'editor.tabSize', 'editor.formatOnSave'],
			},
			{
				id: 'find',
				label: 'Find and replace',
				description: 'Set defaults for searches inside the active editor.',
				settings: ['editor.find.*'],
			},
			{
				id: 'code-intelligence',
				label: 'Code intelligence',
				description: 'Configure completions, hints, and provider annotations.',
				settings: ['editor.suggest.*', 'editor.inlineSuggest.*', 'editor.parameterHints.*', 'editor.inlayHints.*', 'editor.codeLens', 'editor.colorDecorators', 'editor.colorDecoratorsActivatedOn', 'editor.colorDecoratorsLimit', 'editor.defaultColorDecorators'],
			},
			{
				id: 'content-search',
				label: 'Workspace search',
				description: 'Set defaults for searches across workspace files.',
				settings: ['search.*'],
			},
			{
				id: 'diff',
				label: 'Diff editor',
				description: 'Configure how differences are displayed and navigated.',
				settings: ['diffEditor.*'],
			},
			{
				id: 'files',
				label: 'Files',
				description: 'Configure file editing and save behavior.',
				settings: ['files.*'],
			},
		],
	},
	{
		id: 'agents',
		label: 'Agents',
		description: 'Create agents and teams, then configure their shared capabilities.',
		categories: [
			{
				id: 'agents',
				label: 'My Agents',
				description: 'Manage reusable agents and their bounded subagent delegation.',
				keywords: ['agent profiles', 'custom agents', 'subagents', 'delegation'],
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
				groups: [],
			},
			{
				id: 'models',
				label: 'Models',
				description: 'Choose models and configure model-specific behavior.',
				keywords: ['model providers', 'inference'],
				presentation: 'general',
				groups: [],
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
				id: 'tools-and-mcps',
				label: 'Tools & MCPs',
				description: 'Configure tools and Model Context Protocol connections.',
				keywords: ['tools', 'mcp', 'model context protocol'],
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
