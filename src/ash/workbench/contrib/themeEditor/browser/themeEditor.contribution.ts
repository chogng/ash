import { localize, localize2 } from '../../../../nls.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import { IUserThemeService } from '../../../common/userThemes.js';
import { getWindow } from '../../../../base/browser/dom.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { EditorPanes, registerEditorPane } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { CODE_EDITOR_ID, TextResourceEditor } from '../../../browser/parts/editor/textResourceEditor.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import { createThemeEditorInput, getThemeEditorSource, ThemeEditor, ThemeEditorId } from './themeEditor.js';
import './themeEditorAccessibility.js';

const themesMenu = MenuId.for('ThemesSubMenu');
// A popup opens asynchronously. Repeated invocations share that operation,
// while the editor parts remain the only owner of open documents and windows.
const opening = new WeakMap<IEditorPartsService, Map<string, Promise<void>>>();

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
		const extension = source ? undefined : getThemeEditorSource(accessor.get(IExtensionService), theme.id);
		if (!source && !extension) throw new Error(localize('themeEditor.sourceUnavailable', 'The source file for theme {0} is unavailable.', theme.label));
		const resource = source ? URI.joinPath(users.directory!, source.file) : extension!.resource;
		const parts = accessor.get(IEditorPartsService);
		let pending = opening.get(parts);
		if (!pending) opening.set(parts, pending = new Map());
		const key = resource.with({ query: '' }).toString();
		const current = pending.get(key);
		if (current) return current;
		const resources = accessor.get(IExtensionResourceLoaderService);
		const operation = (async () => {
			const existing = parts.parts.find(part => part.editorsMru.some(({ input }) => input.editorId === ThemeEditorId && input.resource.with({ query: '' }).toString() === key));
			if (existing) {
				const editor = existing.editorsMru.find(({ input }) => input.editorId === ThemeEditorId && input.resource.with({ query: '' }).toString() === key)!;
				const target = existing === parts.mainPart ? await parts.openEditorsInNewWindow([editor], 'move') : existing;
				if (target) {
					await target.openEditor(editor.input, { preferredEditorId: ThemeEditorId, pinned: true, revealIfOpened: true });
					getWindow(target.domNode).focus();
				}
				return;
			}
			const packaged = resource.scheme === 'ash-extension-resource';
			const input = createThemeEditorInput({
				resource, label: source?.file ?? resource.path.split('/').at(-1),
				...(packaged ? { initialText: await resources.readExtensionResource(resource), readOnly: true } : {}),
			});
			const target = await parts.createAuxiliaryEditorPart();
			try { await target.openEditor(input, { preferredEditorId: ThemeEditorId, pinned: true }); }
			catch (error) { await parts.closeAuxiliaryEditorPart(target); throw error; }
		})();
		pending.set(key, operation);
		try { await operation; }
		finally { if (pending.get(key) === operation) pending.delete(key); }
	}
});
MenusRegistry.appendMenuItem(themesMenu, {
	command: { id: 'workbench.action.openThemeEditor', title: localize2('themeEditor.open', 'Open Theme Editor') },
	order: 4,
});
