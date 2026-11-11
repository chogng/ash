import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { ILanguageModelToolsService, IToolData, IToolSet, ToolSource } from '../../common/tools/languageModelToolsService.js';
import type { IQuickInputService, IQuickTreeItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { maxDisabledChatTools } from '../../../../services/chat/common/chatContextService.js';
import { browserChatToolReferenceNames } from '../../../../../platform/browserView/common/browserChatToolReferenceNames.js';
import Severity from '../../../../../base/common/severity.js';

interface ToolPick extends IQuickTreeItem {
	readonly id: string;
	readonly toolName?: string;
	readonly children?: readonly ToolPick[];
}

export function toolSetLabel(set: IToolSet): string {
	const labels: Record<ToolSource, string> = {
		environment: localize('chat.tools.environment', 'Environment tools'),
		dynamic: localize('chat.tools.dynamic', 'Client tools'),
		extension: localize('chat.tools.extension', 'Extension tools'),
		host: localize('chat.tools.host', 'Host tools'),
		local: localize('chat.tools.local', 'Built-in tools'),
		mcp: localize('chat.tools.mcp', 'MCP tools'),
	};
	return set.sourceId ? localize('chat.tools.sourceGroup', '{0}: {1}', labels[set.source], set.sourceId) : labels[set.source];
}

/** Edits an unsent selection. Escape discards it; Apply commits it to the originating composer. */
export function showToolsPicker(quickInput: IQuickInputService, toolsService: ILanguageModelToolsService, currentDisabled: readonly string[], signal: AbortSignal): Promise<readonly string[] | undefined> {
	const resources = new DisposableStore();
	const picker = resources.add(quickInput.createQuickTree<ToolPick>());
	resources.add(toDisposable(() => picker.hide()));
	const disabled = new Set(currentDisabled);
	picker.title = localize('chat.tools.configureLabel', 'Configure tools');
	picker.placeholder = localize('chat.tools.configureTreeHint', 'Search tools; use Space to toggle tools or sets, and Enter to apply.');
	picker.ariaLabel = localize('chat.tools.configureLabel', 'Configure tools');
	picker.description = localize('chat.tools.selectionDescription', 'Select a group to change all of its tools. Changes apply only to this chat.');
	picker.matchOnDescription = true;
	picker.sortByLabel = false;
	return new Promise(resolve => {
		let settled = false;
		const finish = (result?: readonly string[]): void => {
			if (settled) { return; }
			settled = true;
			resolve(result);
			resources.dispose();
		};
		const render = (): void => {
			const tools = [...toolsService.getAllToolsIncludingDisabled()].filter(tool => tool.exposure !== 'hidden');
			const toolSets = [...toolsService.toolSets.get()];
			const active = picker.activeItems[0]?.id;
			const assigned = new Set<string>();
			const toolItem = (tool: IToolData): ToolPick => ({
				id: `tool:${tool.id}`, toolName: tool.id, label: tool.displayName,
				description: tool.id, detail: tool.modelDescription, checked: !disabled.has(tool.id),
			});
			const items: ToolPick[] = [];
			const addGroup = (id: string, label: string, members: readonly IToolData[]): void => {
				const children = members.filter(tool => !assigned.has(tool.id)).map(tool => { assigned.add(tool.id); return toolItem(tool); });
				if (children.length) items.push({ id, label, children });
			};
			const browserTools = tools.filter(tool => tool.source === 'local' && browserChatToolReferenceNames.includes(tool.id));
			if (browserTools.length) {
				addGroup('browser', localize('chat.tools.browser', 'Browser tools'), browserTools);
			}
			for (const set of toolSets) {
				const names = new Set([...set.getTools()].map(tool => tool.id));
				addGroup(`set:${set.id}`, toolSetLabel(set), tools.filter(tool => names.has(tool.id)));
			}
			for (const tool of tools) {
				if (!assigned.has(tool.id)) items.push(toolItem(tool));
			}
			picker.setItemTree(items);
			const retained = active && items.flatMap(item => [item, ...(item.children ?? [])]).find(item => item.id === active);
			if (retained) picker.activeItems = [retained];
		};
		resources.add(toolsService.onDidChangeTools(() => render()));
		resources.add(picker.onDidChangeCheckedLeafItems(items => {
			const enabled = new Set(items.map(item => item.toolName));
			for (const tool of toolsService.getAllToolsIncludingDisabled()) {
				if (tool.exposure === 'hidden') continue;
				if (enabled.has(tool.id)) disabled.delete(tool.id);
				else disabled.add(tool.id);
			}
			picker.validationMessage = undefined;
		}));
		resources.add(picker.onDidAccept(() => {
			if (disabled.size > maxDisabledChatTools) {
				picker.severity = Severity.Error;
				picker.validationMessage = localize('chat.tools.selectionLimit', 'Select at most 4096 disabled tools. Enable some tools before applying.');
				return;
			}
			finish([...disabled].sort());
		}));
		resources.add(picker.onDidHide(() => finish()));
		resources.add(addDisposableListener(signal, 'abort', () => finish()));
		if (signal.aborted) { finish(); return; }
		render();
		picker.show();
	});
}
