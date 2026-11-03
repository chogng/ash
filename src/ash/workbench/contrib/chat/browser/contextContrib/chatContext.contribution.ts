import { Disposable, DisposableMap, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../common/contributions.js';
import { IExtensionService, type ExtensionManifest } from '../../../../services/extensions/common/extensionService.js';
import { ChatContextService, IChatContextService } from './chatContextService.js';

/** Declarative source names are window-local; executable providers arrive through the host adapter. */
export class ChatContextContribution extends Disposable {
	public static readonly ID = 'workbench.contrib.chatContextContribution';
	private readonly declarations = this._register(new DisposableMap<string>());

	constructor(
		@IChatContextService private readonly contexts: IChatContextService,
		@IExtensionService private readonly extensions: IExtensionService,
	) {
		super();
		this._register(extensions.onDidChange(() => this.refresh()));
		this.refresh();
	}

	private refresh(): void {
		const active = new Set<string>();
		for (const extension of this.extensions.getExtensionPointContributions<ExtensionManifest['contributes']['chatContext']>('chatContext')) {
			for (const item of extension.value) {
				const id = `${extension.description.id}:${item.id}`;
				active.add(id);
				this.contexts.setChatContextProvider(id, { title: item.displayName, icon: ThemeIcon.fromString(item.icon)! });
				if (!this.declarations.has(id)) this.declarations.set(id, toDisposable(() => this.contexts.unregisterChatContextProvider(id)));
			}
		}
		for (const id of this.declarations.keys()) {
			if (!active.has(id)) this.declarations.deleteAndDispose(id);
		}
	}
}

registerSingleton(IChatContextService, ChatContextService, InstantiationType.Delayed);
registerWorkbenchContribution(ChatContextContribution.ID, WorkbenchPhase.BlockStartup,
	accessor => accessor.get(IInstantiationService).createInstance(ChatContextContribution));
