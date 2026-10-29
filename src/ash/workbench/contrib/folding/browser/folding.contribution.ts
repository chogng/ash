import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';

const configName = 'editor.defaultFoldingRangeProvider';
const providerIds: (string | null)[] = [null];
const providerLabels = new Map<string, string>();

class DefaultFoldingRangeProvider extends Disposable {
	constructor(@ILanguageFeaturesService features: ILanguageFeaturesService, @IExtensionService extensions: IExtensionService) {
		super();
		const updateCandidates = (): void => {
			const ids = new Set(features.foldingRangeProvider.allNoModel().flatMap(provider => (provider.id ? [provider.id] : [])));
			providerLabels.clear();
			for (const extension of extensions.currentCatalog.extensions) {
				if (ids.has(extension.id)) providerLabels.set(extension.id, extension.displayName);
			}
			providerIds.splice(0, providerIds.length, null, ...[...ids].sort((left, right) => left.localeCompare(right)));
		};

		this._register(features.foldingRangeProvider.onDidChange(updateCandidates));
		this._register(extensions.onDidChange(updateCandidates));

		updateCandidates();
	}
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<string | null>({
	key: configName,
	defaultValue: null,
	scope: ConfigurationScope.LANGUAGE_OVERRIDABLE,
	parse: value => {
		if (value !== null && (typeof value !== 'string' || value.length === 0)) {
			throw new TypeError(localize('folding.defaultProvider.invalid', 'The default folding range provider must be a non-empty identifier or null.'));
		}
		return value;
	},
	schema: {
		type: ['string', 'null'],
		default: null,
		get description() {
			return localize('folding.defaultProvider.description', 'Select a folding range provider by its identifier. Null uses all active folding range providers.');
		},
		// Provider availability changes independently of the saved preference.
		anyOf: [
			{
				get enum() {
					return providerIds;
				},
				get enumDescriptions() {
					return providerIds.map(id => (id === null ? localize('folding.defaultProvider.all', 'All active folding range providers') : (providerLabels.get(id) ?? id)));
				},
			},
			{ type: 'string', minLength: 1 },
		],
	},
});

registerWorkbenchContribution('workbench.contrib.folding', WorkbenchPhase.AfterRestored, accessor => accessor.get(IInstantiationService).createInstance(DefaultFoldingRangeProvider));
