import { isHTMLElement } from '../../../../../base/browser/dom.js';
import { localize, localize2 } from '../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { Extensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { registerEditorPane } from '../../../../browser/editor.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { EditorPaneMatch } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID, CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_EDITOR } from './aiCustomizationManagement.js';
import { AICustomizationManagementEditor } from './aiCustomizationManagementEditor.js';
import { AICustomizationManagementEditorInput } from './aiCustomizationManagementEditorInput.js';

registerEditorPane({
	id: AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID,
	name: localize('hooks.managementTitle', 'Agent Customizations: Hooks'),
	canOpen: input => input.resource.scheme === 'ash-customizations' && input.resource.path === '/hooks' ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) { throw new Error('Hooks management requires Workbench services'); }
		return options.instantiationService.createInstance(AICustomizationManagementEditor);
	},
});

registerAction2(class OpenCustomizationManagementEditor extends Action2 {
	constructor() { super({ id: 'aiCustomization.openManagementEditor', title: localize2('hooks.managementTitle', 'Agent Customizations: Hooks'), f1: true }); }
	public override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IEditorService).openEditor(new AICustomizationManagementEditorInput(), { pinned: true });
	}
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.HooksSettings,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError('Hooks accessibility verbosity must be boolean'); }
		return value;
	},
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, priority: 100, name: `aiCustomizationManagement-${type}`,
		when: CONTEXT_AI_CUSTOMIZATION_MANAGEMENT_EDITOR.isEqualTo(true),
		getProvider: accessor => {
			const pane = accessor.get(IEditorPart).activePane;
			if (!(pane instanceof AICustomizationManagementEditor) || !pane.isVisible() || !pane.hasFocus()) { return undefined; }
			const focused = pane.getContainer()?.ownerDocument.activeElement;
			return new AccessibleContentProvider(AccessibleViewProviderId.HooksSettings, { type },
				() => type === AccessibleViewType.Help ? localize({ bundle: 'ash.settings', key: 'hooks.help' }, 'Agent Hooks\nUse Tab and Shift+Tab to reach search, the configuration scope, Edit TOML, Ask Ash, Refresh, Configure Hooks, and events. Press Enter or Space on an event or Hook to expand its details. Search filters event names, Hook IDs, commands, and paths. Configure Hooks selects an event, then a Hook or configuration scope. Edit TOML opens the selected configuration; save it, then choose Refresh. Ask Ash appends a configuration request to the current chat draft without sending it. Configured Hooks still require execution permission.') : pane.getAccessibleContent(),
				() => { if (isHTMLElement(focused) && focused.isConnected) { focused.focus(); } else { pane.focus(); } }, AccessibilityVerbositySettingId.HooksSettings);
		},
	});
}
