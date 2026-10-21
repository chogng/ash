import { canSetBreakpointsIn } from '../common/breakpoints.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { localize, localize2 } from '../../../../nls.js';
import { IDebugService, OPEN_DISASSEMBLY_VIEW_COMMAND_ID } from '../common/debug.js';
import { DisassemblyViewInput } from '../common/disassemblyViewInput.js';

registerAction2(class OpenDisassemblyViewAction extends Action2 {
	constructor() { super({ id: OPEN_DISASSEMBLY_VIEW_COMMAND_ID, title: localize2('debug.openDisassembly', 'Open Disassembly View'), f1: true }); }
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const session = accessor.get(IDebugService).session;
		if (!session?.capabilities.supportsDisassembleRequest) { throw new Error(localize('debug.disassemblyUnsupported', 'The debug adapter does not support disassembly.')); }
		if (session.state !== 'stopped') { throw new Error(localize('debug.disassemblyRequiresPause', 'Pause debugging to view disassembly.')); }
		await accessor.get(IEditorService).openEditor(new DisassemblyViewInput(), { pinned: true });
	}
});

registerAction2(class ToggleBreakpointAction extends Action2 {
	constructor() {
		super({ id: 'editor.debug.action.toggleBreakpoint', title: localize2('debug.toggleBreakpoint', 'Toggle Breakpoint'), f1: true, keybinding: { primary: Keybinding.single(logicalKey('F9')), when: EditorContextKeys.editorTextFocus.isEqualTo(true) } });
	}
	override run(accessor: ServicesAccessor): void {
		const editors = accessor.get(ICodeEditorService);
		const editor = editors.getFocusedCodeEditor() ?? editors.getActiveCodeEditor();
		const model = editor?.getModel();
		const position = editor?.getPosition();
		if (model && position && canSetBreakpointsIn(model.getLanguageId(), accessor.get(IExtensionService), accessor.get(IConfigurationService), accessor.get(IContextKeyService))) { accessor.get(IDebugService).toggleBreakpoint(model.uri, position.lineNumber); }
	}
});
