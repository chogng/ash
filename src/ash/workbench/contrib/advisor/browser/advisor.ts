import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { updateAdvisorConfig, type AdvisorConfigChange } from '../../../services/chat/common/advisor.js';
import { IChatService } from '../../../services/chat/common/chatService.js';
import { modelRefIdentity } from '../../../services/chat/common/modelCatalog.js';

/** Host navigation entries shown alongside the feature's Advisor choices. */
export interface AdvisorNavigationItem extends IQuickPickItem {
	readonly run: () => void | Promise<void>;
}

/** Public Advisor picker; the host retains its navigation and provider-management actions. */
export class AdvisorConfigurationPicker extends Disposable {
	constructor(
		@IChatService private readonly chat: IChatService,
		@ILanguageModelsService private readonly languageModels: ILanguageModelsService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
	) { super(); }

	async show(navigation: readonly AdvisorNavigationItem[]): Promise<void> {
		try {
			const [current, models] = await Promise.all([this.chat.readAdvisorDefault(), this.languageModels.listAdvisorModels()]);
			if (this.isDisposed) { return; }
			type Item = IQuickPickItem & { readonly change?: AdvisorConfigChange; readonly run?: AdvisorNavigationItem['run']; };
			const picker = this._register(this.quickInput.createQuickPick<Item>());
			picker.ariaLabel = localize('chat.settings.advisorAria', 'Chat settings and advisor model');
			picker.placeholder = models.length
				? localize('chat.settings.advisorPlaceholder', 'Choose an advisor model or open all settings')
				: localize('chat.settings.advisorProviderRequired', 'Configure a provider in Chat Settings to choose an advisor model');
			picker.items = [
				...navigation,
				...current ? [{
					label: current.enabled ? localize('chat.settings.advisorDisable', 'Turn Advisor off') : localize('chat.settings.advisorEnable', 'Turn Advisor on'),
					description: current.model ? `${current.model.provider}/${current.model.model}` : localize('advisor.settings.inherit', 'Inherit from chat'),
					change: { type: 'setEnabled' as const, enabled: !current.enabled },
				}, {
					label: localize('chat.settings.advisorClear', 'Clear saved Advisor model'),
					change: { type: 'clear' as const },
				}] : [],
				...models.filter(entry => this.languageModels.isModelVisible(entry.model)).map(entry => ({
					label: entry.displayName,
					description: current?.model && modelRefIdentity(current.model) === modelRefIdentity(entry.model)
						? localize('chat.settings.current', 'Current') : `${entry.model.provider}/${entry.model.model}`,
					change: { type: 'selectModel' as const, model: entry },
				})),
			];
			let saving = false;
			this._register(picker.onDidAccept(() => {
				if (saving) { return; }
				const item = picker.selectedItems[0];
				if (!item) { return; }
				if (item.run) {
					picker.hide();
					void item.run();
					return;
				}
				if (!item.change) { return; }
				saving = true;
				void this.chat.saveAdvisorDefault(updateAdvisorConfig(current, item.change)).then(
					() => { if (!this.isDisposed) { picker.hide(); } },
					error => {
						if (this.isDisposed) { return; }
						saving = false;
						picker.placeholder = `${localize('chat.settings.advisorSaveFailed', 'Could not save advisor model')}: ${String(error)}`;
					},
				);
			}));
			// This transient UI releases its service subscriptions when dismissed.
			this._register(picker.onDidHide(() => this.dispose()));
			picker.show();
		} catch (error) {
			this.dispose();
			throw error;
		}
	}
}
