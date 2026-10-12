import { localize, localize2 } from '../../../../nls.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import { IUserThemeService } from '../../../common/userThemes.js';
import { serializeUserColorThemeDraft } from '../../../services/themes/common/colorThemeData.js';
import { EditorPanes, registerEditorPane } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { CODE_EDITOR_ID, TextResourceEditor } from '../../../browser/parts/editor/textResourceEditor.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import { createThemeEditorInput, ThemeEditor, ThemeEditorId } from './themeEditor.js';
import './themeEditorAccessibility.js';

const themesMenu = MenuId.for('ThemesSubMenu');

registerEditorPane({
	id: ThemeEditorId,
	name: localize('themeEditor.title', 'Theme Editor'),
	canOpen: input => input.editorId === ThemeEditorId ? EditorPaneMatch.Default : /\.json$/iu.test(input.resource.path) ? EditorPaneMatch.Optional : EditorPaneMatch.None,
	createInput: createThemeEditorInput,
	create: async options => {
		if (!options.instantiationService) throw new Error('Theme Editor requires an editor service scope');
		const descriptor = EditorPanes.getEditorPane(options.input!, { preferredEditorId: CODE_EDITOR_ID });
		let editor: ThemeEditor;
		const text = await descriptor!.create({ ...options, onSave: () => editor.save() });
		if (!(text instanceof TextResourceEditor)) { text.dispose(); throw new TypeError('Theme Editor requires a text resource editor'); }
		try { editor = options.instantiationService.createInstance(ThemeEditor, text); return editor; }
		catch (error) { text.dispose(); throw error; }
	},
});

registerAction2(class OpenThemeEditorAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.openThemeEditor', title: localize2('themeEditor.open', 'Open Theme Editor'), f1: true });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const users = accessor.get(IUserThemeService);
		if (!users.available) throw new Error(localize('themeEditor.unavailable', 'User theme files are unavailable in this window.'));
		const theme = accessor.get(IWorkbenchThemeService).getColorTheme();
		const source = users.sourceFor(theme.id);
		const input = createThemeEditorInput(source
			? { resource: URI.file(users.directory! + '/' + source.file), label: source.file }
			: { resource: URI.parse('untitled:/theme-' + crypto.randomUUID() + '.json'), label: localize('themeEditor.copyName', '{0} Copy', theme.label), initialText: serializeUserColorThemeDraft(theme, localize('themeEditor.copyName', '{0} Copy', theme.label)) });
		const parts = accessor.get(IEditorPartsService);
		const existing = parts.parts.find(part => part.editorsMru.some(({ input: editor }) => editor.editorId === ThemeEditorId && editor.resource.toString() === input.resource.toString()));
		const target = existing ?? await parts.createAuxiliaryEditorPart();
		await target.openEditor(input, { preferredEditorId: ThemeEditorId, pinned: true });
	}
});
MenusRegistry.appendMenuItem(themesMenu, {
	command: { id: 'workbench.action.openThemeEditor', title: localize2('themeEditor.open', 'Open Theme Editor') },
	order: 4,
});
