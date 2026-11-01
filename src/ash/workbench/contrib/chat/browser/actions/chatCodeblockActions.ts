import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatWidgetService } from '../chat.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IUntitledTextEditorService } from '../../../../services/untitled/common/untitledTextEditorService.js';
import { localize2 } from '../../../../../nls.js';
import type { ICodeBlockActionContext } from '../widget/chatContentParts/codeBlockPart.js';
import { InsertCodeBlockOperation } from './codeBlockOperations.js';

export function isCodeBlockActionContext(value: unknown): value is ICodeBlockActionContext {
	if (!value || typeof value !== 'object') return false;
	const context = value as Partial<ICodeBlockActionContext>;
	return typeof context.code === 'string' && Number.isInteger(context.codeBlockIndex) && context.codeBlockIndex! >= 0
		&& (context.languageId === undefined || typeof context.languageId === 'string');
}

export function registerChatCodeBlockActions(): void {
	for (const previous of [false, true]) {
		registerAction2(class NavigateCodeBlockAction extends Action2 {
			constructor() {
				super({
					id: previous ? 'workbench.action.chat.previousCodeBlock' : 'workbench.action.chat.nextCodeBlock',
					title: previous ? localize2('chat.code.previous', 'Chat: Previous Code Block') : localize2('chat.code.next', 'Chat: Next Code Block'),
					f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true),
					keybinding: {
						primary: KeyMod.CtrlCmd | KeyMod.Alt | (previous ? KeyCode.PageUp : KeyCode.PageDown),
						weight: KeybindingWeight.WorkbenchContrib, when: ChatContextKeys.inChatSession.isEqualTo(true)
					}
				});
			}
			public override run(accessor: ServicesAccessor): void {
				const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
				if (!widget?.visible) { return; }
				widget.focusCodeBlock(previous);
			}
		});
	}
	registerAction2(class CopyCodeBlockAction extends Action2 {
		constructor() { super({ id: 'workbench.action.chat.copyCodeBlock', title: localize2('chat.code.copy', 'Copy') }); }
		public override async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
			if (isCodeBlockActionContext(context)) await accessor.get(IClipboardService).writeText(context.code);
		}
	});
	registerAction2(class InsertAtCursorAction extends Action2 {
		constructor() { super({ id: 'workbench.action.chat.insertCodeBlock', title: localize2('chat.code.insert', 'Insert at cursor') }); }
		public override async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
			if (isCodeBlockActionContext(context)) await accessor.get(IInstantiationService).createInstance(InsertCodeBlockOperation).run(context);
		}
	});
	registerAction2(class InsertIntoNewFileAction extends Action2 {
		constructor() { super({ id: 'workbench.action.chat.insertIntoNewFile', title: localize2('chat.code.newFile', 'Open in new file') }); }
		public override async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
			if (!isCodeBlockActionContext(context)) return;
			const model = accessor.get(IUntitledTextEditorService).create({ initialValue: context.code, languageId: context.languageId });
			await accessor.get(IEditorService).openEditor({ resource: model.resource, languageId: context.languageId }, { pinned: true });
		}
	});
}
