import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { findLast } from '../../../../../base/common/arraysFind.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { reviveChatTreeData } from '../../common/chatService/chatService.js';
import type { IChatListItem } from '../../common/model/chatViewModel.js';
import { IChatWidgetService } from '../chat.js';
import { CHAT_CATEGORY } from './chatActions.js';

function hasTree(item: IChatListItem): boolean {
	const content = item.toolInvocation?.result?.content ?? item.content ?? [];
	return content.some(part => part.type === 'artifact'
		&& !part.artifact.truncated
		&& part.artifact.source.type !== 'resourceLink'
		&& part.artifact.source.type !== 'mcpApp'
		&& part.artifact.source.type !== 'viewMetadata'
		&& part.artifact.data.type === 'json'
		&& !!reviveChatTreeData(part.artifact.data.json));
}

export function registerChatFileTreeActions(): void {
	for (const reverse of [false, true]) {
		registerAction2(class extends Action2 {
			constructor() {
				super({
					id: reverse ? 'workbench.action.chat.previousFileTree' : 'workbench.action.chat.nextFileTree',
					title: reverse ? localize2('chat.fileTree.previous', 'Previous File Tree') : localize2('chat.fileTree.next', 'Next File Tree'),
					category: CHAT_CATEGORY, f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true),
					keybinding: { primary: KeyMod.CtrlCmd | (reverse ? KeyMod.Shift : 0) | KeyCode.F9, weight: KeybindingWeight.WorkbenchContrib, when: ChatContextKeys.inChatSession.isEqualTo(true) },
				});
			}
			override run(accessor: ServicesAccessor): void {
				if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) return;
				const widget = accessor.get(IChatWidgetService).lastFocusedWidget;
				if (!widget?.visible) return;
				const focused = widget.getFocus();
				const response = focused && hasTree(focused) ? focused : findLast(widget.model?.items ?? [], hasTree);
				if (!response) return;
				widget.reveal(response);
				const trees = widget.getFileTreeInfosForResponse(response);
				if (!trees.length) return;
				const current = widget.getLastFocusedFileTreeForResponse(response);
				const index = current ? (current.treeIndex + (reverse ? -1 : 1) + trees.length) % trees.length : reverse ? trees.length - 1 : 0;
				trees[index]?.focus();
			}
		});
	}
}
