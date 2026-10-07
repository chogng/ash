import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { AgentCapabilitiesSnapshot, AgentToolSetCapability, ToolSource } from '../../../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { filterQuickPickItems } from '../../../../../platform/quickinput/browser/quickInputList.js';
import type { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';

interface ToolPick extends IQuickPickItem {
	readonly names?: readonly string[];
}

export function toolSetLabel(set: AgentToolSetCapability): string {
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

export function createToolSelectionAttachment(disabled: readonly string[]): ChatContextAttachment {
	const content = JSON.stringify([...disabled].sort());
	const name = localize('chat.tools.selection', 'Tool selection: {0} disabled', disabled.length);
	return {
		id: 'tool-selection', kind: 'toolSelection', name,
		resolve: async () => ({ name, content, kind: 'toolSelection' }),
	};
}

/** Edits an unsent selection. Escape discards it; Apply commits it to the originating composer. */
export function showToolsPicker(quickInput: IQuickInputService, catalog: AgentCapabilitiesSnapshot, currentDisabled: readonly string[], signal: AbortSignal): Promise<readonly string[] | undefined> {
	const resources = new DisposableStore();
	const picker = resources.add(quickInput.createQuickPick<ToolPick>());
	resources.add(toDisposable(() => picker.hide()));
	const disabled = new Set(currentDisabled);
	picker.placeholder = localize('chat.tools.configureHint', 'Search tools; Enter toggles a tool or set. Choose Apply to save for this chat.');
	picker.ariaLabel = localize('chat.tools.configureLabel', 'Configure tools');
	return new Promise(resolve => {
		let settled = false;
		const finish = (result?: readonly string[]): void => {
			if (settled) { return; }
			settled = true;
			resolve(result);
			resources.dispose();
		};
		const render = (): void => {
			const state = (names: readonly string[]): string => {
				const count = names.filter(name => !disabled.has(name)).length;
				return count === names.length ? localize('chat.tools.enabled', 'Enabled') : count === 0 ? localize('chat.tools.disabled', 'Disabled') : localize('chat.tools.mixed', 'Partly enabled');
			};
			const items: ToolPick[] = [];
			for (const set of catalog.toolSets) {
				items.push({ label: toolSetLabel(set), description: state(set.tools), picked: set.tools.every(name => !disabled.has(name)), detail: localize('chat.tools.setMembers', 'Tool set: {0}', set.tools.join(', ')), names: set.tools });
			}
			for (const tool of catalog.tools.filter(tool => tool.exposure !== 'hidden')) {
				items.push({ label: tool.name, description: state([tool.name]), picked: !disabled.has(tool.name), detail: tool.description, names: [tool.name] });
			}
			picker.items = [...filterQuickPickItems(items, picker.value), { label: localize('chat.tools.apply', 'Apply tool selection'), alwaysShow: true }];
		};
		resources.add(picker.onDidChangeValue(render));
		resources.add(picker.onDidAccept(item => {
			if (!item.names) {
				if (disabled.size > 4096) { status(localize('chat.tools.selectionLimit', 'Select at most 4096 disabled tools. Enable some tools before applying.')); return; }
				finish([...disabled].sort()); return;
			}
			const enable = item.names.some(name => disabled.has(name));
			for (const name of item.names) {
				if (enable) { disabled.delete(name); } else { disabled.add(name); }
			}
			status(localize('chat.tools.changed', '{0}: {1}', item.label, enable ? localize('chat.tools.enabled', 'Enabled') : localize('chat.tools.disabled', 'Disabled')));
			render();
		}));
		resources.add(picker.onDidHide(() => finish()));
		resources.add(addDisposableListener(signal, 'abort', () => finish()));
		if (signal.aborted) { finish(); return; }
		render();
		picker.show();
	});
}
