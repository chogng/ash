import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatWidgetService, type IChatWidget, type IChatFindController } from '../chat.js';
import { ChatFindCommandId } from '../widget/chatFind/chatFindCommandIds.js';

export function resolveFocusedChatWidget(widgets: readonly IChatWidget[], lastFocusedWidget: IChatWidget | undefined, isFocusAncestor: (element: HTMLElement) => boolean): IChatWidget | undefined {
	return widgets.find(widget => widget.visible && widget.getFindController() && isFocusAncestor(widget.domNode)) ?? (lastFocusedWidget?.visible ? lastFocusedWidget : undefined);
}

export function getFocusedFindController(accessor: ServicesAccessor): IChatFindController | undefined {
	const widgets = accessor.get(IChatWidgetService);
	return resolveFocusedChatWidget(widgets.getAllWidgets(), widgets.lastFocusedWidget, element => element.contains(element.ownerDocument.activeElement))?.getFindController();
}

export function registerChatFindActions(): void {
	const supported = ContextKeyExpr.and(ChatContextKeys.enabled.isEqualTo(true), ChatContextKeys.findSupported.isEqualTo(true));
	const visible = ContextKeyExpr.and(supported, ChatContextKeys.findWidgetVisible.isEqualTo(true));
	registerAction2(class extends Action2 {
		constructor() {
			super({
				id: ChatFindCommandId.Find, title: localize2('chat.find', 'Find in Chat'), f1: true,
				precondition: ChatContextKeys.enabled.isEqualTo(true),
				keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyF, weight: KeybindingWeight.WorkbenchContrib + 1, when: ContextKeyExpr.and(supported, ChatContextKeys.inChatSession.isEqualTo(true)) },
			});
		}
		public override run(accessor: ServicesAccessor): void {
			const widgets = accessor.get(IChatWidgetService);
			const widget = resolveFocusedChatWidget(widgets.getAllWidgets(), widgets.lastFocusedWidget, element => element.contains(element.ownerDocument.activeElement));
			if (!widget) { return; }
			const editor = accessor.get(ICodeEditorService).getFocusedCodeEditor();
			let seed: string | undefined;
			if (editor && widget.domNode.contains(editor.getContainerDomNode())) {
				const selection = editor.getSelection();
				if (selection && !selection.isEmpty()) {
					const text = editor.getModel()?.getValueInRange(selection);
					if (text?.trim()) seed = text;
				}
			}
			const selection = widget.domNode.ownerDocument.getSelection();
			if (!seed && selection?.anchorNode && widget.domNode.contains(selection.anchorNode)) {
				const text = selection.toString();
				if (text.trim()) seed = text;
			}
			widget.getFindController()?.show(seed);
		}
	});
	for (const [id, title, primary, secondary, operation] of [
		[ChatFindCommandId.FindNext, localize2('chat.find.next', 'Next match'), KeyCode.F3, KeyCode.Enter, (controller: IChatFindController) => controller.next()],
		[ChatFindCommandId.FindPrevious, localize2('chat.find.previous', 'Previous match'), KeyMod.Shift | KeyCode.F3, KeyMod.Shift | KeyCode.Enter, (controller: IChatFindController) => controller.previous()],
	] as const) {
		registerAction2(class extends Action2 {
			constructor() {
				super({
					id, title, precondition: visible,
					keybinding: [
						{ primary, mac: { primary: KeyMod.CtrlCmd | (id === ChatFindCommandId.FindPrevious ? KeyMod.Shift : 0) | KeyCode.KeyG, secondary: [primary] }, weight: KeybindingWeight.WorkbenchContrib + 1, when: ChatContextKeys.inChatSession.isEqualTo(true) },
						{ primary: secondary, weight: KeybindingWeight.WorkbenchContrib + 1, when: ChatContextKeys.findInputFocused.isEqualTo(true) },
					],
				});
			}
			public override run(accessor: ServicesAccessor): void {
				const controller = getFocusedFindController(accessor);
				if (controller) { operation(controller); }
			}
		});
	}
	for (const [id, title, primary, operation] of [
		[ChatFindCommandId.FindHide, localize2('chat.find.close', 'Close Find'), KeyCode.Escape, (controller: IChatFindController) => controller.hide()],
		[ChatFindCommandId.ToggleFindCaseSensitive, localize2('chat.find.case', 'Match case'), KeyMod.Alt | KeyCode.KeyC, (controller: IChatFindController) => controller.toggleCaseSensitive()],
		[ChatFindCommandId.ToggleFindWholeWord, localize2('chat.find.word', 'Whole word'), KeyMod.Alt | KeyCode.KeyW, (controller: IChatFindController) => controller.toggleWholeWord()],
		[ChatFindCommandId.ToggleFindRegex, localize2('chat.find.regex', 'Regular expression'), KeyMod.Alt | KeyCode.KeyR, (controller: IChatFindController) => controller.toggleRegex()],
	] as const) {
		registerAction2(class extends Action2 {
			constructor() {
				super({ id, title, precondition: visible, keybinding: { primary, weight: KeybindingWeight.WorkbenchContrib + 1, when: ChatContextKeys.findWidgetFocused.isEqualTo(true) } });
			}
			public override run(accessor: ServicesAccessor): void {
				const controller = getFocusedFindController(accessor);
				if (controller) { operation(controller); }
			}
		});
	}
}
