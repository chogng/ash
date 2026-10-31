import { localize } from '../../../../nls.js';

// Keep classification in one place for the inspector and catalog coverage checks.
// More specific families precede broad editor and text families.
export const themeEditorColorGroups = [
	{ id: 'sessions', get label() { return localize('themeEditor.group.sessions', 'Agent Window'); }, pattern: /^sessions\./u },
	{ id: 'chat', get label() { return localize('themeEditor.group.chat', 'Chat'); }, pattern: /^chat\./u },
	{ id: 'collaboration', get label() { return localize('themeEditor.group.collaboration', 'Collaboration'); }, pattern: /^collaboration\./u },
	{
		id: 'syntax',
		get label() { return localize('themeEditor.group.syntax', 'Syntax highlighting'); },
		pattern: /^(?:editor\.(?:token|semanticToken)\.|semanticTokenColors\.)/u,
	},
	{
		id: 'diff',
		get label() { return localize('themeEditor.group.diff', 'Diff'); },
		pattern: /^(?:diffEditor|multiDiffEditor|diff\.|editorGutter\.(?:added|deleted|modified)|editorOverviewRuler\.(?:added|deleted|modified))/u,
	},
	{
		id: 'surface',
		get label() { return localize('themeEditor.group.surface', 'Surface'); },
		pattern: /^(?:background$|workbench\.|widget\.|titleBar\.|commandCenter\.|window\.|dialog\.|hover\.|screenshot\.)/u,
	},
	{
		id: 'text',
		get label() { return localize('themeEditor.group.text', 'Text and borders'); },
		pattern: /^(?:foreground$|description\.|muted\.|disabled|accent\.|error\.|warning\.|success\.|focusBorder$|contrast|border$|icon\.|selection\.|sectionHeader\.|text)/u,
	},
	{
		id: 'editor',
		get label() { return localize('themeEditor.group.editor', 'Editor'); },
		pattern: /^(?:editor(?!Group)|merge\.|peekView|problems\.|searchEditor|search\.)/u,
	},
	{ id: 'tabs', get label() { return localize('themeEditor.group.tabs', 'Tabs'); }, pattern: /^(?:tab\.|tabList\.|editorGroup)/u },
	{
		id: 'sidebar',
		get label() { return localize('themeEditor.group.sidebar', 'Sidebar and navigation'); },
		pattern: /^(?:sideBar|activityBar|modernActivityBarItem\.|compositeBar\.|breadcrumb|navigation|files\.)/u,
	},
	{
		id: 'panel',
		get label() { return localize('themeEditor.group.panel', 'Panels'); },
		pattern: /^(?:panel|auxiliaryBar|debugConsole|outputView)/u,
	},
	{
		id: 'controls',
		get label() { return localize('themeEditor.group.controls', 'Controls'); },
		pattern: /^(?:input|button|checkbox|radio|dropdown|toolbar|actionBar\.|keybinding|sash|badge)/u,
	},
	{
		id: 'lists',
		get label() { return localize('themeEditor.group.lists', 'Lists and menus'); },
		pattern: /^(?:list\.|tree\.|menu\.|menubar\.|quickInput|quickPick)/u,
	},
	{
		id: 'status',
		get label() { return localize('themeEditor.group.status', 'Status and notifications'); },
		pattern: /^(?:statusBar|notification|progressBar|banner\.)/u,
	},
	{ id: 'terminal', get label() { return localize('themeEditor.group.terminal', 'Terminal'); }, pattern: /^terminal/u },
	{
		id: 'scm',
		get label() { return localize('themeEditor.group.scm', 'Version control'); },
		pattern: /^(?:git|scm\.|scmGraph\.)/u,
	},
	{ id: 'settings', get label() { return localize('themeEditor.group.settings', 'Settings'); }, pattern: /^settings\./u },
	{ id: 'debug', get label() { return localize('themeEditor.group.debug', 'Debugging'); }, pattern: /^debugIcon\./u },
	{ id: 'charts', get label() { return localize('themeEditor.group.charts', 'Charts'); }, pattern: /^charts\./u },
	{
		id: 'scrollbar',
		get label() { return localize('themeEditor.group.scrollbar', 'Scrollbar and minimap'); },
		pattern: /^(?:scrollbar|scrollView|scrollShadow|minimap)/u,
	},
	// Unknown extension color families remain editable without borrowing an unrelated category.
	{ id: 'other', get label() { return localize('themeEditor.group.other', 'Other'); }, pattern: /./u },
] as const;

export function getThemeColorGroup(id: string): typeof themeEditorColorGroups[number]['id'] {
	return themeEditorColorGroups.find(group => group.pattern.test(id))!.id;
}
