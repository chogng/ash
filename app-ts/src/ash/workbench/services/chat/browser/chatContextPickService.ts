import { DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { IQuickPickItem, IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import type { ChatContextAttachment, ChatContextPick, ChatContextPicker, IChatContextPickService } from '../common/chatContextService.js';

interface PickerItem extends IQuickPickItem {
	readonly picker: ChatContextPicker;
}

interface ContextItem extends IQuickPickItem {
	readonly attachment: ChatContextAttachment;
}

export class ChatContextPickService implements IChatContextPickService {
	private readonly pickers = new Map<string, ChatContextPicker>();

	registerPicker(picker: ChatContextPicker): IDisposable {
		if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(picker.id) || !picker.label.trim()) {
			throw new TypeError('Chat context picker requires a valid ID and label');
		}
		if (this.pickers.has(picker.id)) throw new Error(`Chat context picker is already registered: ${picker.id}`);
		this.pickers.set(picker.id, picker);
		return toDisposable(() => {
			if (this.pickers.get(picker.id) === picker) this.pickers.delete(picker.id);
		});
	}

	async pickContext(quickInputService: IQuickInputService): Promise<ChatContextAttachment | undefined> {
		const enabled: ChatContextPicker[] = [];
		for (const picker of this.pickers.values()) {
			if (await picker.isEnabled()) enabled.push(picker);
		}
		if (enabled.length === 0) return undefined;
		const picker = enabled.length === 1 ? enabled[0] : await selectItem<PickerItem>(
			quickInputService,
			enabled.map(candidate => ({ label: candidate.label, picker: candidate })),
			'Select context source',
		).then(item => item?.picker);
		if (!picker) return undefined;
		return selectContext(quickInputService, picker);
	}
}

async function selectContext(quickInputService: IQuickInputService, provider: ChatContextPicker): Promise<ChatContextAttachment | undefined> {
	const quickPick = quickInputService.createQuickPick<ContextItem>();
	quickPick.placeholder = `Select ${provider.label.toLocaleLowerCase()}`;
	const resources = new DisposableStore();
	resources.add(quickPick);
	let generation = 0;
	let settled = false;
	return new Promise<ChatContextAttachment | undefined>(resolve => {
		const finish = (attachment: ChatContextAttachment | undefined): void => {
			if (settled) return;
			settled = true;
			resolve(attachment);
			resources.dispose();
		};
		const load = async (query: string): Promise<void> => {
			const current = ++generation;
			try {
				const picks = await provider.providePicks(query);
				if (settled || current !== generation) return;
				quickPick.items = picks.map(toContextItem);
			} catch {
				if (!settled && current === generation) quickPick.items = [];
			}
		};
		resources.add(quickPick.onDidChangeValue(value => void load(value)));
		resources.add(quickPick.onDidAccept(item => finish(item.attachment)));
		resources.add(quickPick.onDidHide(() => finish(undefined)));
		quickPick.show();
		void load('');
	});
}

function selectItem<T extends IQuickPickItem>(quickInputService: IQuickInputService, items: readonly T[], placeholder: string): Promise<T | undefined> {
	const quickPick = quickInputService.createQuickPick<T>();
	quickPick.items = items;
	quickPick.placeholder = placeholder;
	const resources = new DisposableStore();
	resources.add(quickPick);
	let settled = false;
	return new Promise<T | undefined>(resolve => {
		const finish = (item: T | undefined): void => {
			if (settled) return;
			settled = true;
			resolve(item);
			resources.dispose();
		};
		resources.add(quickPick.onDidAccept(item => finish(item)));
		resources.add(quickPick.onDidHide(() => finish(undefined)));
		quickPick.show();
	});
}

function toContextItem(pick: ChatContextPick): ContextItem {
	return {
		label: pick.label,
		description: pick.description,
		detail: pick.detail,
		attachment: pick.attachment,
	};
}
