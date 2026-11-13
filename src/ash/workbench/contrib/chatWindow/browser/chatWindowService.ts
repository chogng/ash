import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { ITitleService } from '../../../services/title/browser/titleService.js';
import { ChatAuxiliaryWindow } from '../../chat/browser/widgetHosts/chatAuxiliaryWindow.js';
import type { IChatWindow, IChatWindowContent, IChatWindowService } from './chatWindow.js';

export class ChatWindowService extends Disposable implements IChatWindowService {
	private readonly windows = this._register(new DisposableMap<HTMLElement, IChatWindow & IDisposable>());
	private readonly opening = new Map<HTMLElement, Promise<void>>();

	constructor(
		@IAuxiliaryWindowService private readonly auxiliaryWindows: IAuxiliaryWindowService,
		@ITitleService private readonly titleService: ITitleService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
	}

	public async open(content: IChatWindowContent): Promise<void> {
		this.assertNotDisposed();
		const { element } = content;
		const pending = this.opening.get(element);
		if (pending) {
			return pending;
		}
		const existing = this.windows.get(element);
		if (existing) {
			return existing.focus();
		}
		const opening = this.openWindow(content);
		this.opening.set(element, opening);
		try {
			await opening;
		} finally {
			this.opening.delete(element);
		}
	}

	public getWindowForChat(element: HTMLElement): IChatWindow | undefined {
		return this.windows.get(element);
	}

	private async openWindow(content: IChatWindowContent): Promise<void> {
		const { element, title } = content;
		const window = await this.auxiliaryWindows.open({ title, width: 900, height: 760 });
		const resources = new DisposableStore();
		resources.add(toDisposable(() => window.dispose()));
		try {
			if (this.isDisposed || !content.isAvailable()) {
				resources.dispose();
				return;
			}
			const shell = this.titleService.createAuxiliaryTitlebarPart(window.container, unregister =>
				this.instantiationService.createInstance(ChatAuxiliaryWindow, window, title, unregister));
			resources.add(toDisposable(() => shell.dispose()));
			const chatWindow: IChatWindow & IDisposable = Object.assign(resources, {
				focus: async () => {
					try {
						await window.focus();
					} catch (error) {
						if (!resources.isDisposed) throw error;
					}
					if (!resources.isDisposed) content.focus(window);
				},
				setTitle: (title: string) => shell.setTitle(title),
				close: () => {
					if (this.windows.get(element) === chatWindow) {
						this.windows.deleteAndDispose(element);
					}
				},
			});
			this.windows.set(element, chatWindow);
			resources.add(window.onDidClose(chatWindow.close));
			content.mount(window, shell.header, () => shell.mount(element), resources);
			if (resources.isDisposed) {
				return;
			}
			window.layout();
			if (!resources.isDisposed) {
				await chatWindow.focus();
			}
		} catch (error) {
			// Forget the window before the host reconciles its layout during cleanup.
			this.windows.deleteAndLeak(element);
			resources.dispose();
			throw error;
		}
	}
}
