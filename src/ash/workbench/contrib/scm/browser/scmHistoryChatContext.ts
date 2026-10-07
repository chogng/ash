import type { IView } from '../../../common/views.js';
import { localize2 } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { CHAT_VIEW_ID } from '../../chat/common/chat.js';
import { IChatContextPickService, type ChatContextAttachment, type ChatContextPick, type IChatContextTarget } from '../../../services/chat/common/chatContextService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import type { SCMHistoryItemChangeViewModelTreeElement, SCMHistoryItemViewModelTreeElement } from '../common/history.js';
import { ISCMService, type ISCMService as ISCMServiceType } from '../common/scm.js';

const HistoryLimit = 100;

/** Registers SCM history as a searchable, lazily resolved Chat context source. */
export class ScmHistoryChatContextContribution extends Disposable {
	constructor(contextPickService: IChatContextPickService, scmService: ISCMServiceType) {
		super();
		this._register(contextPickService.registerPicker({
			id: 'scm.history',
			label: 'Source Control',
			isEnabled: async () => [...scmService.repositories].some(repository => repository.provider.historyProvider !== undefined),
			providePicks: query => historyPicks(scmService, query),
		}));
	}
}

export function createHistoryItemChatAttachment(element: SCMHistoryItemViewModelTreeElement): ChatContextAttachment {
	const { repository, historyItemViewModel } = element;
	const historyItem = historyItemViewModel.historyItem;
	const historyProvider = repository.provider.historyProvider;
	if (!historyProvider) throw new Error(`Repository '${repository.id}' does not provide history`);
	return {
		id: `${repository.id}:${historyItem.id}`,
		kind: 'scmHistoryItem',
		name: `${historyItem.displayId ?? historyItem.id} · ${historyItem.subject}`,
		resolve: async () => {
			const content = await historyProvider.resolveHistoryItemChatContext(historyItem.id);
			if (content === undefined) throw new Error(`History item '${historyItem.id}' is unavailable`);
			return { name: `${historyItem.displayId ?? historyItem.id} · ${historyItem.subject}`, content };
		},
	};
}

export function createHistoryItemChangeChatAttachment(element: SCMHistoryItemChangeViewModelTreeElement): ChatContextAttachment {
	const { repository, historyItemViewModel, historyItemChange } = element;
	const historyItem = historyItemViewModel.historyItem;
	const historyProvider = repository.provider.historyProvider;
	if (!historyProvider) throw new Error(`Repository '${repository.id}' does not provide history`);
	return {
		id: `${repository.id}:${historyItem.id}:${historyItemChange.path}`,
		kind: 'scmHistoryItemChange',
		name: historyItemChange.path,
		resolve: async () => {
			const content = await historyProvider.resolveHistoryItemChangeRangeChatContext(historyItem.id, historyItem.parentIds[0] ?? '', historyItemChange.path);
			if (content === undefined) throw new Error(`History change '${historyItemChange.path}' is unavailable`);
			return { name: `${historyItem.displayId ?? historyItem.id} · ${historyItemChange.path}`, content };
		},
	};
}

async function historyPicks(scmService: ISCMServiceType, rawQuery: string): Promise<readonly ChatContextPick[]> {
	const query = rawQuery.trim().toLocaleLowerCase();
	const picks: ChatContextPick[] = [];
	for (const repository of scmService.repositories) {
		const historyProvider = repository.provider.historyProvider;
		if (!historyProvider) continue;
		const historyItems = await historyProvider.provideHistoryItems({ limit: HistoryLimit });
		for (const historyItem of historyItems ?? []) {
			if (query && !historyItem.subject.toLocaleLowerCase().includes(query) && !historyItem.id.toLocaleLowerCase().includes(query)) continue;
			picks.push({
				label: historyItem.subject,
				description: historyItem.displayId ?? historyItem.id,
				detail: historyItem.timestamp === undefined ? repository.provider.label : new Date(historyItem.timestamp).toLocaleString(),
				attachment: createHistoryItemChatAttachment({
					repository,
					historyItemViewModel: { historyItem, inputSwimlanes: [], outputSwimlanes: [], kind: 'node' },
					type: 'historyItemViewModel',
				}),
			});
		}
	}
	return picks;
}

async function revealChat(accessor: ServicesAccessor): Promise<IChatContextTarget | undefined> {
	return await accessor.get(IViewsService).openView<IView & IChatContextTarget>(CHAT_VIEW_ID) ?? undefined;
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.scm.action.graph.addHistoryItemToChat',
			title: localize2({ bundle: 'ash.workbench', key: 'command.workbench.scm.action.graph.addHistoryItemToChat' }, 'Add to Chat'),
			menu: { id: MenuId.SCMHistoryItemContext, group: 'z_chat', order: 1 },
		});
	}

	override async run(accessor: ServicesAccessor, element: SCMHistoryItemViewModelTreeElement): Promise<void> {
		if (!isHistoryItem(element)) return;
		const view = await revealChat(accessor);
		view?.addContext(createHistoryItemChatAttachment(element));
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.scm.action.graph.summarizeHistoryItem',
			title: localize2({ bundle: 'ash.workbench', key: 'command.workbench.scm.action.graph.summarizeHistoryItem' }, 'Explain Changes'),
			menu: { id: MenuId.SCMHistoryItemContext, group: 'z_chat', order: 2 },
		});
	}

	override async run(accessor: ServicesAccessor, element: SCMHistoryItemViewModelTreeElement): Promise<void> {
		if (!isHistoryItem(element)) return;
		const view = await revealChat(accessor);
		if (!view) return;
		view.addContext(createHistoryItemChatAttachment(element));
		await view.acceptInput('Explain the changes in the attached commit.');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.scm.action.graph.addHistoryItemChangeToChat',
			title: localize2({ bundle: 'ash.workbench', key: 'command.workbench.scm.action.graph.addHistoryItemToChat' }, 'Add to Chat'),
			menu: { id: MenuId.SCMHistoryItemChangeContext, group: 'z_chat', order: 1 },
		});
	}

	override async run(accessor: ServicesAccessor, element: SCMHistoryItemChangeViewModelTreeElement): Promise<void> {
		if (!isHistoryItemChange(element)) return;
		const view = await revealChat(accessor);
		view?.addContext(createHistoryItemChangeChatAttachment(element));
	}
});

function isHistoryItem(value: unknown): value is SCMHistoryItemViewModelTreeElement {
	return typeof value === 'object' && value !== null &&
		(value as SCMHistoryItemViewModelTreeElement).type === 'historyItemViewModel' &&
		typeof (value as SCMHistoryItemViewModelTreeElement).historyItemViewModel?.historyItem?.id === 'string';
}

function isHistoryItemChange(value: unknown): value is SCMHistoryItemChangeViewModelTreeElement {
	return typeof value === 'object' && value !== null &&
		(value as SCMHistoryItemChangeViewModelTreeElement).type === 'historyItemChangeViewModel' &&
		typeof (value as SCMHistoryItemChangeViewModelTreeElement).historyItemChange?.path === 'string';
}
