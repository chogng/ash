import { localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { BrowserViewCommandId } from '../../../../../platform/browserView/common/browserView.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { BROWSER_EDITOR_ACTIVE, BrowserActionCategory, BrowserEditor, CONTEXT_BROWSER_HAS_ERROR, CONTEXT_BROWSER_HAS_URL } from '../browserEditor.js';
import { ContextKeyExpr, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { Keybinding, logicalKey } from '../../../../../base/common/keybindings.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';

export const CONTEXT_BROWSER_DEVTOOLS_OPEN = new RawContextKey<boolean>('browserDevToolsOpen', false);

registerAction2(class ToggleDevToolsAction extends Action2 {
	constructor() {
		super({
			id: BrowserViewCommandId.ToggleDevTools,
			title: localize2({ bundle: 'ash.workbench', key: 'browser.devToolsAction' }, 'Developer Tools'),
			category: BrowserActionCategory,
			icon: Lxicon.inspect,
			f1: true,
			precondition: ContextKeyExpr.and(BROWSER_EDITOR_ACTIVE, CONTEXT_BROWSER_HAS_URL.isEqualTo(true), CONTEXT_BROWSER_HAS_ERROR.isEqualTo(false)),
			toggled: CONTEXT_BROWSER_DEVTOOLS_OPEN.isEqualTo(true),
			menu: { id: MenuId.BrowserActionsToolbar, group: 'tools', order: 2 },
			keybinding: { primary: Keybinding.single(logicalKey('F12')), weight: KeybindingWeight.WorkbenchContrib },
		});
	}
	public override async run(accessor: ServicesAccessor, browserEditor: unknown = accessor.get(IEditorService).activeEditorPane): Promise<void> {
		if (browserEditor instanceof BrowserEditor) { await browserEditor.model?.toggleDevTools(); }
	}
});
