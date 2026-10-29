import { isHTMLElement } from '../../../../../base/browser/dom.js';
import { localize, localize2 } from '../../../../../nls.js';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
} from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerEditorPane } from '../../../../browser/editor.js';
import { EditorPaneMatch } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { EditorInputSerializers } from '../../../../services/editor/common/editorInputSerializer.js';
import { CONTEXT_MODELS_EDITOR, MANAGE_CHAT_COMMAND_ID } from '../../common/constants.js';
import { ModelsManagementEditor } from './chatManagementEditor.js';
import { ModelsManagementEditorInput } from './chatManagementEditorInput.js';

// Working-set restoration must retain singleton behavior instead of falling back to a plain resource.
EditorInputSerializers.registerStatic({
	typeId: ModelsManagementEditorInput.ID,
	canSerialize: input => input instanceof ModelsManagementEditorInput,
	serialize: () => null,
	deserialize: value => {
		if (value !== null) {
			throw new TypeError('Invalid serialized models management input');
		}
		return new ModelsManagementEditorInput();
	},
});

registerEditorPane({
	id: ModelsManagementEditor.ID,
	name: localize('modelsManagementEditorInputName', 'Language Models'),
	canOpen: input =>
		input.resource.scheme === 'ash-models' && input.resource.path === '/management'
			? EditorPaneMatch.Default
			: EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) {
			throw new Error('Models management requires Workbench services');
		}
		return options.instantiationService.createInstance(ModelsManagementEditor);
	},
});

registerAction2(
	class ManageLanguageModels extends Action2 {
		constructor() {
			super({
				id: MANAGE_CHAT_COMMAND_ID,
				title: localize2('openAiManagement', 'Manage Language Models'),
				f1: true,
			});
		}

		public override async run(
			accessor: ServicesAccessor,
			searchQuery?: unknown,
		): Promise<ModelsManagementEditor | undefined> {
			if (searchQuery !== undefined && typeof searchQuery !== 'string') {
				throw new TypeError('Model search must be a string');
			}
			const editors = accessor.get(IEditorService);
			await editors.openEditor(new ModelsManagementEditorInput(), { pinned: true });
			const pane = editors.visibleEditorPanes.find(
				(candidate): candidate is ModelsManagementEditor => candidate instanceof ModelsManagementEditor,
			);
			if (pane && searchQuery !== undefined) {
				pane.search(searchQuery);
			}
			return pane;
		}
	},
);

registerAction2(
	class ClearModelsSearch extends Action2 {
		constructor() {
			super({
				id: 'chat.models.action.clearSearchResults',
				title: localize2('models.clearResults', 'Clear Models Search Results'),
				precondition: CONTEXT_MODELS_EDITOR.isEqualTo(true),
				f1: true,
			});
		}

		public override run(accessor: ServicesAccessor): void {
			const pane = accessor.get(IEditorService).activeEditorPane;
			if (pane instanceof ModelsManagementEditor) {
				pane.clearSearch();
			}
		}
	},
);

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type,
		priority: 100,
		name: `models-management-${type}`,
		when: CONTEXT_MODELS_EDITOR.isEqualTo(true),
		getProvider: accessor => {
			const pane = accessor.get(IEditorService).activeEditorPane;
			if (!(pane instanceof ModelsManagementEditor) || !pane.isVisible() || !pane.hasFocus()) {
				return undefined;
			}
			const root = pane.getContainer()!;
			const focused = root.ownerDocument.activeElement;
			return new AccessibleContentProvider(
				AccessibleViewProviderId.ChatModelConfiguration,
				{ type },
				() =>
					type === AccessibleViewType.Help
						? localize(
								'models.management.help',
								'Language Models shows the chat model catalog. Use Tab and Shift+Tab to reach Open Settings, Search models, and model switches. Search filters the catalog by name or ID. Escape clears the search. Space toggles a model in the chat picker. Open Settings configures provider credentials and custom models.',
							)
						: root.innerText || root.textContent || '',
				() => {
					if (isHTMLElement(focused) && focused.isConnected) {
						focused.focus();
					} else {
						pane.focus();
					}
				},
				AccessibilityVerbositySettingId.ChatModelConfiguration,
			);
		},
	});
}
