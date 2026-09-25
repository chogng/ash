import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import { OpenEditorsFocusedContext } from '../common/files.js';
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
import './editors/fileEditorHandler.js';
import "./fileActions.contribution.js";

const configuration = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
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
		() => localize('accessibility.explorerHelp', 'Explorer\nUse the arrow keys to move through files and folders. Press Right Arrow to expand a folder and Left Arrow to collapse it. Press Enter to open a file. Press Ctrl+F to find loaded file names. Press Escape to close find. Press Alt+F2 to read the visible files.'),
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
		const view = accessor.get(IViewsService).openView(OpenEditorsView.ID);
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
		const view = accessor.get(IViewsService).openView(OpenEditorsView.ID);
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
