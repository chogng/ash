import { IChatAttachmentResolveService } from '../../chat/browser/attachments/chatAttachmentResolveService.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { IChatContextPickService, picksWithPromiseFn, type IChatContextPickerPickItem } from '../../chat/browser/attachments/chatContextPickService.js';
import type { IView } from '../../../common/views.js';
import { localize2 } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { CHAT_VIEW_ID } from '../../chat/common/chat.js';
import { type IChatContextTarget } from '../../../services/chat/common/chatContextService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { type SCMHistoryItemChangeViewModelTreeElement, type SCMHistoryItemViewModelTreeElement } from '../common/history.js';
import { ISCMService, type ISCMService as ISCMServiceType } from '../common/scm.js';

const HistoryLimit = 100;

/** Registers SCM history as a searchable, lazily resolved Chat context source. */
export class ScmHistoryChatContextContribution extends Disposable {
	constructor(
		@IChatContextPickService contextPickService: IChatContextPickService,
		@ISCMService scmService: ISCMServiceType,
		@IChatAttachmentResolveService resolver: IChatAttachmentResolveService,
	) {
		super();
		const label = localize('chat.context.sourceControl', 'Source Control');
		this._register(contextPickService.registerChatContextItem({
			type: 'pickerPick', label, icon: Lxicon.gitCommit,
			isEnabled: async () => [...scmService.repositories].some(repository => repository.provider.historyProvider !== undefined),
			asPicker: () => ({ placeholder: localize('chat.context.select', 'Select {0}', label), picks: picksWithPromiseFn(query => historyPicks(scmService, query, resolver)) }),
		}));
	}
}

async function historyPicks(scmService: ISCMServiceType, rawQuery: string, resolver: IChatAttachmentResolveService): Promise<IChatContextPickerPickItem[]> {
	const query = rawQuery.trim().toLocaleLowerCase();
	const picks: IChatContextPickerPickItem[] = [];
	for (const repository of scmService.repositories) {
		const historyProvider = repository.provider.historyProvider;
		if (!historyProvider) continue;
		const historyItems = await historyProvider.provideHistoryItems({ limit: HistoryLimit });
		for (const historyItem of historyItems ?? []) {
			if (query && !historyItem.subject.toLocaleLowerCase().includes(query) && !historyItem.id.toLocaleLowerCase().includes(query)) continue;
			const attachment = resolver.resolveSourceControlHistoryItemAttachContext([{
				repository,
				historyItemViewModel: { historyItem, inputSwimlanes: [], outputSwimlanes: [], kind: 'node' },
				type: 'historyItemViewModel',
			}])[0]!;
			picks.push({
				label: historyItem.subject,
				description: historyItem.displayId ?? historyItem.id,
				detail: historyItem.timestamp === undefined ? repository.provider.label : new Date(historyItem.timestamp).toLocaleString(),
				asAttachment: () => attachment,
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
		view?.addContext(accessor.get(IChatAttachmentResolveService).resolveSourceControlHistoryItemAttachContext([element])[0]!);
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
		view.addContext(accessor.get(IChatAttachmentResolveService).resolveSourceControlHistoryItemAttachContext([element])[0]!);
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
		view?.addContext(accessor.get(IChatAttachmentResolveService).resolveSourceControlHistoryItemAttachContext([element])[0]!);
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
