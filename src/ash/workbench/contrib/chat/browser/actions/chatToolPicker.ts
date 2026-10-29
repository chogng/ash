import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { ILanguageModelToolsService, IToolSet, ToolSource } from '../../common/tools/languageModelToolsService.js';
import { filterQuickPickItems } from '../../../../../platform/quickinput/browser/quickInputList.js';
import type { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
import { browserChatToolReferenceNames } from '../../../../../platform/browserView/common/browserChatToolReferenceNames.js';

interface ToolPick extends IQuickPickItem {
	readonly key: string;
	readonly names?: readonly string[];
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
	return set.sourceId
		? localize('chat.tools.sourceGroup', '{0}: {1}', labels[set.source], set.sourceId)
		: labels[set.source];
}

export function createToolSelectionAttachment(disabled: readonly string[]): ChatContextAttachment {
	const content = JSON.stringify([...disabled].sort());
	const name = localize('chat.tools.selection', 'Tool selection: {0} disabled', disabled.length);
	return {
		id: 'tool-selection',
		kind: 'toolSelection',
		name,
		resolve: async () => ({ name, content, kind: 'toolSelection' }),
	};
}

/** Edits an unsent selection. Escape discards it; Apply commits it to the originating composer. */
export function showToolsPicker(
	quickInput: IQuickInputService,
	toolsService: ILanguageModelToolsService,
	currentDisabled: readonly string[],
	signal: AbortSignal,
): Promise<readonly string[] | undefined> {
	const resources = new DisposableStore();
	const picker = resources.add(quickInput.createQuickPick<ToolPick>());
	resources.add(toDisposable(() => picker.hide()));
	const disabled = new Set(currentDisabled);
	picker.placeholder = localize(
		'chat.tools.configureHint',
		'Search tools; Enter toggles a tool or set. Choose Apply to save for this chat.',
	);
	picker.ariaLabel = localize('chat.tools.configureLabel', 'Configure tools');
	return new Promise(resolve => {
		let settled = false;
		const finish = (result?: readonly string[]): void => {
			if (settled) {
				return;
			}
			settled = true;
			resolve(result);
			resources.dispose();
		};
		const render = (retainActive = true): void => {
			const tools = [...toolsService.getAllToolsIncludingDisabled()];
			const toolSets = [...toolsService.toolSets.get()];
			const active = retainActive ? picker.activeItems[0] : undefined;
			const state = (names: readonly string[]): string => {
				const count = names.filter(name => !disabled.has(name)).length;
				return count === names.length
					? localize('chat.tools.enabled', 'Enabled')
					: count === 0
						? localize('chat.tools.disabled', 'Disabled')
						: localize('chat.tools.mixed', 'Partly enabled');
			};
			const items: ToolPick[] = [];
			const browserTools = tools
				.filter(
					tool =>
						tool.source === 'local' &&
						tool.exposure !== 'hidden' &&
						browserChatToolReferenceNames.includes(tool.id),
				)
				.map(tool => tool.id);
			if (browserTools.length) {
				items.push({
					key: 'browser',
					label: localize('chat.tools.browser', 'Browser tools'),
					description: state(browserTools),
					picked: browserTools.every(name => !disabled.has(name)),
					names: browserTools,
				});
			}
			for (const set of toolSets) {
				const names = [...set.getTools()].map(tool => tool.id);
				items.push({
					key: `set:${set.id}`,
					label: toolSetLabel(set),
					description: state(names),
					picked: names.every(name => !disabled.has(name)),
					detail: localize('chat.tools.setMembers', 'Tool set: {0}', names.join(', ')),
					names,
				});
			}
			for (const tool of tools.filter(tool => tool.exposure !== 'hidden')) {
				items.push({
					key: `tool:${tool.id}`,
					label: tool.displayName,
					description: state([tool.id]),
					picked: !disabled.has(tool.id),
					detail: tool.modelDescription,
					names: [tool.id],
				});
			}
			const visible: ToolPick[] = [
				...filterQuickPickItems(items, picker.value),
				{ key: 'apply', label: localize('chat.tools.apply', 'Apply tool selection'), alwaysShow: true },
			];
			picker.items = visible;
			const retained = active && visible.find(item => item.key === active.key);
			if (retained) picker.activeItems = [retained];
		};
		resources.add(toolsService.onDidChangeTools(() => render()));
		resources.add(picker.onDidChangeValue(() => render(false)));
		resources.add(
			picker.onDidAccept(() => {
				const item = picker.selectedItems[0];
				if (!item) return;

				if (!item.names) {
					if (disabled.size > 4096) {
						status(
							localize(
								'chat.tools.selectionLimit',
								'Select at most 4096 disabled tools. Enable some tools before applying.',
							),
						);
						return;
					}
					finish([...disabled].sort());
					return;
				}
				const enable = item.names.some(name => disabled.has(name));
				for (const name of item.names) {
					if (enable) {
						disabled.delete(name);
					} else {
						disabled.add(name);
					}
				}
				status(
					localize(
						'chat.tools.changed',
						'{0}: {1}',
						item.label,
						enable
							? localize('chat.tools.enabled', 'Enabled')
							: localize('chat.tools.disabled', 'Disabled'),
					),
				);
				render();
			}),
		);
		resources.add(picker.onDidHide(() => finish()));
		resources.add(addDisposableListener(signal, 'abort', () => finish()));
		if (signal.aborted) {
			finish();
			return;
		}
		render();
		picker.show();
	});
}
