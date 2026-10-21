import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { type CancellationToken } from '../../../../base/common/cancellation.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { FormattingConflicts, FormattingMode } from '../../../../editor/contrib/format/browser/format.js';
import { type DocumentFormattingEditProvider, type DocumentRangeFormattingEditProvider } from '../../../../editor/common/languages.js';
import { type ITextModel } from '../../../../editor/common/model.js';
import { localize } from '../../../../nls.js';

const defaultFormatter = Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<string | null>({
	key: 'editor.defaultFormatter', defaultValue: null, scope: ConfigurationScope.LANGUAGE_OVERRIDABLE,
	schema: { type: ['string', 'null'], description: localize('format.default.description', 'The extension identifier used to format this language.') },
	parse: value => {
		if (value !== null && (typeof value !== 'string' || !value.trim())) throw new TypeError('editor.defaultFormatter must be an extension identifier or null');
		return value as string | null;
	},

});

/** Owns the window's formatter policy; document edits and cancellation remain in Editor. */
export class DefaultFormatter extends Disposable {
	private readonly pickers = this._register(new DisposableStore());
	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
	) {
		super();
		this._register(FormattingConflicts.setFormatterSelector((providers, model, mode, _kind, token) => this.select(providers, model, mode, token)));
	}

	private async select<T extends DocumentFormattingEditProvider | DocumentRangeFormattingEditProvider>(providers: T[], model: ITextModel, mode: FormattingMode, token: CancellationToken): Promise<T | undefined> {
		const preferred = this.configuration.getValue<string | null>(defaultFormatter, { resource: model.uri, overrideIdentifier: model.getLanguageId() });
		const match = preferred && providers.find(provider => provider.extensionId && ExtensionIdentifier.equals(provider.extensionId, preferred));
		if (match) return match;
		if (!preferred && providers.length === 1) return providers[0];
		if (mode === FormattingMode.Silent || token.isCancellationRequested) return undefined;
		interface Item extends IQuickPickItem { readonly provider?: T; readonly configure?: boolean; }
		using picker = this.quickInput.createQuickPick<Item>();
		picker.ariaLabel = localize('format.select', 'Select a Formatter');
		picker.placeholder = picker.ariaLabel;
		const choices: Item[] = providers.map((provider, index) => ({
			label: provider.displayName ?? provider.extensionId?.value ?? localize('format.numbered', 'Formatter {0}', index + 1),
			description: provider.extensionId?.value,
			provider,
		}));
		picker.items = [...choices, { label: localize('format.configure', 'Configure Default Formatter...'), configure: true }];
		const active = this.pickers.add(toDisposable(() => picker.hide()));
		try {
			return await new Promise<T | undefined>((resolve, reject) => {
				const listeners = new DisposableStore();
				let result: T | undefined;
				let saveDefault = false;
				listeners.add(picker.onDidAccept(() => {
					const item = picker.selectedItems[0];
					if (item?.configure) {
						saveDefault = true;
						picker.placeholder = localize('format.default.select', 'Select the Default Formatter for {0}', model.getLanguageId());
						picker.items = choices.filter(item => item.provider?.extensionId);
						picker.value = '';
						return;
					}
					if (!item?.provider) return;
					if (!saveDefault) { result = item.provider; picker.hide(); return; }
					void this.configuration.updateValue(defaultFormatter, item.provider.extensionId!.value, { overrideIdentifier: model.getLanguageId() }, ConfigurationTarget.USER).then(() => {
						if (!token.isCancellationRequested) result = item.provider;
						picker.hide();
					}, error => { reject(error); picker.hide(); });
				}));
				listeners.add(picker.onDidHide(() => { listeners.dispose(); resolve(result); }));
				listeners.add(token.onCancellationRequested(() => picker.hide()));
				picker.show();
			});
		} finally { this.pickers.delete(active); }
	}
}
