import { assertEncoding, GUESSABLE_ENCODINGS, getEncodingLabel, SUPPORTED_ENCODINGS } from '../../../services/textfile/common/encoding.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { OpenEditorsFocusedContext, SortOrder, LexicographicOptions } from '../common/files.js';
import { ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
import { DirtyFilesIndicator } from '../common/dirtyFilesIndicator.js';
import { IActivityService } from '../../../services/activity/common/activity.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ExplorerFileNestingSettingId } from '../common/explorerFileNestingTrie.js';
import { ExplorerFocusedContext, IExplorerService } from './files.js';
import { ExplorerService } from './explorerService.js';
import { OpenEditorsView } from './views/openEditorsView.js';
import { TextFileEditorTracker } from './editors/textFileEditorTracker.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorPanes } from '../../../browser/editor.js';
import { binaryFileEditorDescriptor } from './editors/binaryFileEditor.js';
import './editors/fileEditorHandler.js';
import "./fileActions.contribution.js";

EditorPanes.registerEditorPane(binaryFileEditorDescriptor());

const configuration = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
configuration.registerConfiguration<string>({
	key: 'files.encoding', defaultValue: 'utf8', scope: ConfigurationScope.LANGUAGE_OVERRIDABLE,
	schema: { type: 'string', enum: Object.keys(SUPPORTED_ENCODINGS).filter(id => !SUPPORTED_ENCODINGS[id].hidden) },
	parse(value: unknown): string {
		assertEncoding(value);
		return value;
	},
	setting: { valueType: 'select', title: localize('files.encodingTitle', 'Default File Encoding'), description: localize('files.encodingDescription', 'Choose the default encoding for reading and writing text files. Can be overridden per language.'), options: Object.keys(SUPPORTED_ENCODINGS).filter(id => !SUPPORTED_ENCODINGS[id].hidden).map(value => ({ value, label: getEncodingLabel(value) })) },
});
configuration.registerConfiguration<boolean>({
	key: 'files.autoGuessEncoding', defaultValue: false, scope: ConfigurationScope.LANGUAGE_OVERRIDABLE,
	schema: { type: 'boolean' },
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError(localize('files.invalidAutoGuessEncoding', 'Automatic encoding detection must be true or false.'));
		return value;
	},
	setting: { valueType: 'boolean', title: localize('files.autoGuessEncodingTitle', 'Auto Guess File Encoding'), description: localize('files.autoGuessEncodingDescription', 'Attempt to detect the character encoding when opening text files. BOM and UTF-16 detection always take precedence. Can be overridden per language.') },
});
configuration.registerConfiguration<readonly string[]>({
	key: 'files.candidateGuessEncodings', defaultValue: [], scope: ConfigurationScope.LANGUAGE_OVERRIDABLE,
	schema: { type: 'array', items: { type: 'string', enum: Object.keys(GUESSABLE_ENCODINGS) }, uniqueItems: true, description: localize('files.candidateGuessEncodingsDescription', 'Limit automatic guesses to these encodings. An empty list uses all detectable encodings. If detection is inconclusive, use a legacy candidate only when it is the sole lossless match; otherwise use the default file encoding.') },
	parse(value: unknown): readonly string[] {
		if (!Array.isArray(value) || value.length > Object.keys(GUESSABLE_ENCODINGS).length || value.some(id => !Object.hasOwn(GUESSABLE_ENCODINGS, id)) || new Set(value).size !== value.length) throw new TypeError(localize('files.invalidCandidateGuessEncodings', 'Enter a list of unique detectable encoding identifiers.'));
		return Object.freeze(value.slice());
	},
});
configuration.registerConfiguration({
	key: 'explorer.sortOrder',
	defaultValue: SortOrder.Default,
	scope: ConfigurationScope.WINDOW,
	schema: { type: 'string', enum: Object.values(SortOrder) },
	parse(value: unknown): SortOrder {
		if (!Object.values(SortOrder).includes(value as SortOrder)) throw new TypeError(localize('files.invalidSortOrder', 'Invalid Explorer sort order.'));
		return value as SortOrder;
	},
	setting: {
		valueType: 'select',
		title: localize('files.sortOrderTitle', 'Explorer sort order'),
		description: localize('files.sortOrderDescription', 'Choose how files and folders are ordered in Explorer.'),
		options: [
			{ value: SortOrder.Default, label: localize('files.sortFoldersFirst', 'Folders first') },
			{ value: SortOrder.Mixed, label: localize('files.sortMixed', 'Files and folders together') },
			{ value: SortOrder.FilesFirst, label: localize('files.sortFilesFirst', 'Files first') },
			{ value: SortOrder.Type, label: localize('files.sortType', 'File type') },
			{ value: SortOrder.Modified, label: localize('files.sortModified', 'Last modified') },
			{ value: SortOrder.FoldersNestsFiles, label: localize('files.sortNests', 'Folders and nested files first') },
		],
	},
});
configuration.registerConfiguration({
	key: 'explorer.sortOrderLexicographicOptions',
	defaultValue: LexicographicOptions.Default,
	scope: ConfigurationScope.WINDOW,
	schema: { type: 'string', enum: Object.values(LexicographicOptions) },
	parse(value: unknown): LexicographicOptions {
		if (!Object.values(LexicographicOptions).includes(value as LexicographicOptions)) throw new TypeError(localize('files.invalidLexicographicOrder', 'Invalid Explorer name order.'));
		return value as LexicographicOptions;
	},
	setting: {
		valueType: 'select',
		title: localize('files.lexicographicTitle', 'Explorer name order'),
		description: localize('files.lexicographicDescription', 'Choose how letter case is handled when sorting file names.'),
		options: [
			{ value: LexicographicOptions.Default, label: localize('files.lexicographicDefault', 'Natural order') },
			{ value: LexicographicOptions.Upper, label: localize('files.lexicographicUpper', 'Uppercase first') },
			{ value: LexicographicOptions.Lower, label: localize('files.lexicographicLower', 'Lowercase first') },
			{ value: LexicographicOptions.Unicode, label: localize('files.lexicographicUnicode', 'Unicode order') },
		],
	},
});
for (const [key, defaultValue, title, description] of [
	['explorer.enableDragAndDrop', true, localize('files.dragEnabledTitle', 'Enable Explorer drag and drop'), localize('files.dragEnabledDescription', 'Move, copy, or import files by dragging them into a folder.')],
	['explorer.confirmDragAndDrop', true, localize('files.dragConfirmTitle', 'Confirm file moves by dragging'), localize('files.dragConfirmDescription', 'Ask before moving files with drag and drop.')],
	['explorer.compactFolders', true, localize('files.compactFoldersTitle', 'Compact folders'), localize('files.compactFoldersDescription', 'Show folders with a single child folder in one row.')],
	['explorer.sortOrderReverse', false, localize('files.sortReverseTitle', 'Reverse Explorer sort order'), localize('files.sortReverseDescription', 'Reverse the order within each group of files and folders.')],
	['explorer.decorations.colors', true, localize('files.decorationColorsTitle', 'Explorer decoration colors'), localize('files.decorationColorsDescription', 'Show file status colors in Explorer.')],
	['explorer.decorations.badges', true, localize('files.decorationBadgesTitle', 'Explorer decoration badges'), localize('files.decorationBadgesDescription', 'Show file status badges in Explorer.')],
] as const) {
	configuration.registerConfiguration({
		key, defaultValue, scope: ConfigurationScope.WINDOW, schema: { type: 'boolean' },
		parse(value: unknown): boolean {
			if (typeof value !== 'boolean') throw new TypeError(localize('files.invalidBooleanSetting', '{0} must be a boolean.', key));
			return value;
		},
		setting: { valueType: 'boolean', title, description },
	});
}
configuration.registerConfiguration({
	key: ExplorerFileNestingSettingId.Enabled,
	defaultValue: false,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') {
			throw new TypeError('Explorer file nesting enabled must be boolean');
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('files.nesting.enabledTitle', 'File nesting'),
		description: localize('files.nesting.enabledDescription', 'Group related files under a parent file in Explorer.'),
	},
});
configuration.registerConfiguration({
	key: ExplorerFileNestingSettingId.Patterns,
	defaultValue: {
		'*.ts': '${capture}.js',
		'*.js': '${capture}.js.map, ${capture}.min.js, ${capture}.d.ts',
		'*.jsx': '${capture}.js',
		'*.tsx': '${capture}.ts',
		'tsconfig.json': 'tsconfig.*.json',
		'package.json': 'package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lockb, bun.lock',
	},
	parse(value: unknown): Record<string, string> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new TypeError('Explorer file nesting patterns must be an object');
		}
		for (const [parent, children] of Object.entries(value)) {
			if (typeof children !== 'string' || !parent.trim() || !children.trim() || parent.split('*').length > 2 || children.split(',').some(pattern => !pattern.trim() || pattern.trim().split('*').length > 2)) {
				throw new TypeError(`Invalid Explorer file nesting pattern: ${parent}`);
			}
		}
		return value as Record<string, string>;
	},
	setting: {
		valueType: 'stringMap',
		title: localize('files.nesting.patternsTitle', 'File nesting patterns'),
		description: localize('files.nesting.patternsDescription', 'Match child files under a parent file. Use * and ${capture}; separate multiple child patterns with commas.'),
		keyLabel: localize('files.nesting.parentPattern', 'Parent file pattern'),
		valueLabel: localize('files.nesting.childPatterns', 'Child file patterns'),
		addLabel: localize('files.nesting.addPattern', 'Add pattern'),
		removeLabel: localize('files.nesting.removePattern', 'Remove pattern'),
		incompleteMessage: localize('files.nesting.incompletePattern', 'Enter both a parent and child pattern.'),
		duplicateMessage: localize('files.nesting.duplicatePattern', 'Each parent pattern must be unique.'),
	},
});

registerSingleton(IExplorerService, ExplorerService, InstantiationType.Delayed);
registerWorkbenchContribution(DirtyFilesIndicator.ID, WorkbenchPhase.AfterRestored, accessor => new DirtyFilesIndicator(
	accessor.get(IActivityService),
	accessor.get(IWorkingCopyService),
));
registerWorkbenchContribution('workbench.contrib.textFileEditorTracker', WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(TextFileEditorTracker, window));

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 100,
	name: 'explorerHelp',
	when: ExplorerFocusedContext.isEqualTo(true),
	getProvider: accessor => new AccessibleContentProvider(
		AccessibleViewProviderId.Explorer,
		{ type: AccessibleViewType.Help },
		() => localize('accessibility.explorerHelp', 'Explorer\nUse Tab to reach the Explorer title actions and the arrow keys to choose New File, New Folder, Refresh Explorer, or Collapse Folders in Explorer. Press Enter or Space to run the selected action. Use the arrow keys to move through files and folders. Use Page Up and Page Down to move by one visible page. Type a file or folder name to move focus to a matching visible item; repeat its first letter to cycle through matches. Press Right Arrow to expand a folder and Left Arrow to collapse it. In a compact folder row, Left and Right Arrow move between folder names before expanding or collapsing. Press Enter to open a file. Press the Context Menu key or Shift+F10 for file actions. Press Ctrl or Command+X to cut selected files, Ctrl or Command+C to copy them, and Ctrl or Command+V to paste into a folder. You can also paste files copied from your system file manager. Files cut in Windows or Linux file managers move into the selected local folder. On Mac, press Option+Command+V to move copied files into the selected local folder. Press Escape to cancel a cut. Press Ctrl or Command+F to find file names, including collapsed folders. Press Escape to close find. Press Alt+F2 to read the visible files. From an editor tab, press Shift+F10 to close editors, copy file paths, split selected editors, or choose Reveal in Explorer View to locate its file in this tree. On a workspace root, the context menu offers Add Folder to Workspace and Remove Folder from Workspace. Removing a root keeps its files on disk. Use Add Folder to Workspace, Remove Folder from Workspace, and Save Workspace As in the File menu or Command Palette to manage local workspace roots. Open Workspace Configuration File edits the folders list; saved changes update the workspace automatically. Use Close Folder or Close Workspace in the File menu to return to an empty workspace after resolving unsaved changes.'),
		() => accessor.get(IExplorerService).focus(),
		AccessibilityVerbositySettingId.Explorer,
	),
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.View,
	priority: 100,
	name: 'explorerView',
	when: ExplorerFocusedContext.isEqualTo(true),
	getProvider: accessor => {
		const explorer = accessor.get(IExplorerService);
		const content = explorer.getAccessibleContent();
		if (content === undefined) return undefined;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.Explorer,
			{ type: AccessibleViewType.View },
			() => content,
			() => explorer.focus(),
			AccessibilityVerbositySettingId.Explorer,
		);
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 100,
	name: 'openEditorsHelp',
	when: OpenEditorsFocusedContext.isEqualTo(true),
	getProvider: accessor => {
		const view = accessor.get(IViewsService).getActiveViewWithId(OpenEditorsView.ID);
		if (!(view instanceof OpenEditorsView)) return undefined;
		const focused = view.element.ownerDocument.activeElement;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.OpenEditors,
			{ type: AccessibleViewType.Help },
			() => localize('files.openEditors.help', 'Open Editors\nUse the arrow keys to move through open editors. Press Enter to activate an editor. Press Delete to close the focused editor. Press Alt+F2 to read the list.'),
			() => { if (focused instanceof HTMLElement) focused.focus(); },
			AccessibilityVerbositySettingId.OpenEditors,
		);
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.View,
	priority: 100,
	name: 'openEditorsView',
	when: OpenEditorsFocusedContext.isEqualTo(true),
	getProvider: accessor => {
		const view = accessor.get(IViewsService).getActiveViewWithId(OpenEditorsView.ID);
		if (!(view instanceof OpenEditorsView)) return undefined;
		const focused = view.element.ownerDocument.activeElement;
		const content = view.getAccessibleContent();
		return new AccessibleContentProvider(
			AccessibleViewProviderId.OpenEditors,
			{ type: AccessibleViewType.View },
			() => content,
			() => { if (focused instanceof HTMLElement) focused.focus(); },
			AccessibilityVerbositySettingId.OpenEditors,
		);
	},
});
