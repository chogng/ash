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
