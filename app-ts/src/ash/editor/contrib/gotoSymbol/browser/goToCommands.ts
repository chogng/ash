import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2, type ILocalizedString } from '../../../../nls.js';
import { MenuId, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { type ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorAction, registerInstantiatedEditorAction, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { type LanguageNavigationController, type LanguageNavigationKind } from './languageNavigationController.js';

interface NavigationCommand {
	readonly id: string;
	readonly label: ILocalizedString;
	readonly kind: LanguageNavigationKind;
	readonly precondition: ContextKeyExpression;
	readonly order: number;
	readonly keybinding?: number;
	readonly peek?: boolean;
}

// Requests and Peek state remain with the editor's existing navigation controller.
class SymbolNavigationAction extends EditorAction {
	constructor(private readonly command: NavigationCommand) {
		super({
			id: command.id,
			label: command.label,
			precondition: command.precondition,
			contextMenuOpts: {
				menuId: command.peek ? MenuId.EditorContextPeek : MenuId.EditorContext,
				group: command.peek ? 'peek' : 'navigation',
				order: command.order,
			},
			kbOpts: {
				primary: command.keybinding,
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	public async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		editor.focus();
		await editor.getContribution<LanguageNavigationController>('editor.contrib.languageNavigation')?.navigate(this.command.kind, {
			peek: this.command.peek,
			includeDeclaration: this.command.kind === 'references' ? !this.command.peek : undefined,
		});
	}
}

MenusRegistry.appendMenuItem(MenuId.EditorContext, {
	submenu: MenuId.EditorContextPeek,
	title: localize('peek.submenu', 'Peek'),
	group: 'navigation',
	order: 100,
});

const commands: readonly NavigationCommand[] = [
	{
		id: 'editor.action.revealDefinition',
		label: localize2('goToDefinition.label', 'Go to Definition'),
		kind: 'definition', precondition: EditorContextKeys.hasDefinitionProvider.isEqualTo(true),
		order: 1.1, keybinding: KeyCode.F12,
	},
	{
		id: 'editor.action.revealDeclaration',
		label: localize2('goToDeclaration.label', 'Go to Declaration'),
		kind: 'declaration', precondition: EditorContextKeys.hasDeclarationProvider.isEqualTo(true), order: 1.3,
	},
	{
		id: 'editor.action.goToTypeDefinition',
		label: localize2('goToTypeDefinition.label', 'Go to Type Definition'),
		kind: 'typeDefinition', precondition: EditorContextKeys.hasTypeDefinitionProvider.isEqualTo(true), order: 1.4,
	},
	{
		id: 'editor.action.goToImplementation',
		label: localize2('goToImplementation.label', 'Go to Implementations'),
		kind: 'implementation', precondition: EditorContextKeys.hasImplementationProvider.isEqualTo(true),
		order: 1.45, keybinding: KeyMod.CtrlCmd | KeyCode.F12,
	},
	{
		id: 'editor.action.goToReferences',
		label: localize2('goToReferences.label', 'Go to References'),
		kind: 'references', precondition: EditorContextKeys.hasReferenceProvider.isEqualTo(true),
		order: 1.5, keybinding: KeyMod.Shift | KeyCode.F12,
	},
	{
		id: 'editor.action.peekDefinition',
		label: localize2('peekDefinition.label', 'Peek Definition'),
		kind: 'definition', precondition: EditorContextKeys.hasDefinitionProvider.isEqualTo(true),
		order: 2, keybinding: KeyMod.Alt | KeyCode.F12, peek: true,
	},
	{
		id: 'editor.action.peekDeclaration',
		label: localize2('peekDeclaration.label', 'Peek Declaration'),
		kind: 'declaration', precondition: EditorContextKeys.hasDeclarationProvider.isEqualTo(true), order: 3, peek: true,
	},
	{
		id: 'editor.action.peekTypeDefinition',
		label: localize2('peekTypeDefinition.label', 'Peek Type Definition'),
		kind: 'typeDefinition', precondition: EditorContextKeys.hasTypeDefinitionProvider.isEqualTo(true),
		order: 4, peek: true,
	},
	{
		id: 'editor.action.peekImplementation',
		label: localize2('peekImplementation.label', 'Peek Implementations'),
		kind: 'implementation', precondition: EditorContextKeys.hasImplementationProvider.isEqualTo(true),
		order: 5, keybinding: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.F12, peek: true,
	},
	{
		id: 'editor.action.referenceSearch.trigger',
		label: localize2('peekReferences.label', 'Peek References'),
		kind: 'references', precondition: EditorContextKeys.hasReferenceProvider.isEqualTo(true), order: 6, peek: true,
	},
];

for (const command of commands) {
	registerInstantiatedEditorAction(new SymbolNavigationAction(command));
}
