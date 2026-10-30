import { localize, localize2 } from '../../../../nls.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import { IUserThemeService } from '../../../common/userThemes.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import {
	IExtensionResourceLoaderService,
	toExtensionResourceURI,
} from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { EditorPanes, registerEditorPane } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { CODE_EDITOR_ID, TextResourceEditor } from '../../../browser/parts/editor/textResourceEditor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { createThemeEditorInput, getThemeEditorSource, ThemeEditor, ThemeEditorId } from './themeEditor.js';
import './themeEditorAccessibility.js';

const themesMenu = MenuId.for('ThemesSubMenu');
registerEditorPane({
	id: ThemeEditorId,
	name: localize('themeEditor.title', 'Theme Editor'),
	canOpen: input =>
		input.editorId === ThemeEditorId
			? EditorPaneMatch.Default
			: /\.json$/iu.test(input.resource.path)
				? EditorPaneMatch.Optional
				: EditorPaneMatch.None,
	createInput: createThemeEditorInput,
	create: async options => {
		if (!options.instantiationService) throw new Error('Theme Editor requires an editor service scope');
		const descriptor = EditorPanes.getEditorPane(options.input!, { preferredEditorId: CODE_EDITOR_ID });
		let editor: ThemeEditor;
		const text = await descriptor!.create({ ...options, onSave: () => editor.save() });
		if (!(text instanceof TextResourceEditor)) {
			text.dispose();
			throw new TypeError('Theme Editor requires a text resource editor');
		}
		try {
			editor = options.instantiationService.createInstance(ThemeEditor, text);
			return editor;
		} catch (error) {
			text.dispose();
			throw error;
		}
	},
});

registerAction2(
	class OpenThemeEditorAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.openThemeEditor',
				title: localize2('themeEditor.open', 'Open Theme Editor'),
				f1: true,
			});
		}
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const users = accessor.get(IUserThemeService);
			if (!users.available)
				throw new Error(
					localize('themeEditor.unavailable', 'User theme files are unavailable in this window.'),
				);
			const theme = accessor.get(IWorkbenchThemeService).getColorTheme();
			const themeId = theme.id;
			const source = users.sourceFor(themeId);
			const extensions = accessor.get(IExtensionService);
			const extension = source ? undefined : getThemeEditorSource(extensions, themeId);
			if (!source && !extension)
				throw new Error(
					localize(
						'themeEditor.sourceUnavailable',
						'The source file for theme {0} is unavailable.',
						theme.label,
					),
				);
			const resource = source ? URI.joinPath(users.directory!, source.file) : extension!.resource;
			const resources = accessor.get(IExtensionResourceLoaderService);
			const files = accessor.get(IFileService);
			const editors = accessor.get(IEditorService);
			// An installation path does not grant access through the workspace file provider.
			// Only checkout sources are editable. Installed themes are copied into the user profile.
			const stat =
				extension && resource.scheme !== 'ash-extension-resource'
					? await files.stat(resource).catch(() => undefined)
					: undefined;
			const packaged = extension !== undefined && stat === undefined;
			const editorResource = packaged ? toExtensionResourceURI(extension.request) : resource;
			const input = createThemeEditorInput({
				resource: editorResource,
				label: source?.file ?? resource.path.split('/').at(-1),
				...(packaged
					? { initialText: await resources.readExtensionResource(editorResource), readOnly: true }
					: extension && (!extension.developmentRoot || stat?.readonly)
						? { readOnly: true }
						: {}),
			});
			await editors.openEditor(
				input,
				{ preferredEditorId: ThemeEditorId, pinned: true, revealIfOpened: true },
			);
		}
	},
);
MenusRegistry.appendMenuItem(themesMenu, {
	command: { id: 'workbench.action.openThemeEditor', title: localize2('themeEditor.open', 'Open Theme Editor') },
	order: 4,
});
