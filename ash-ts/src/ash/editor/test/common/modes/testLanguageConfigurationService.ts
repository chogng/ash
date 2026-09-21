import { registerBuiltinLanguageConfigurations } from '../../../standalone/common/builtinLanguages.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { type LanguageConfiguration } from '../../../common/languages/languageConfiguration.js';
import {
	type ILanguageConfigurationService,
	LanguageConfigurationRegistry,
	LanguageConfigurationServiceChangeEvent,
	ResolvedLanguageConfiguration,
} from '../../../common/languages/languageConfigurationRegistry.js';

export class TestLanguageConfigurationService extends Disposable implements ILanguageConfigurationService {
	readonly _serviceBrand = undefined;

	private readonly registry = this._register(new LanguageConfigurationRegistry());
	private readonly changeEmitter = this._register(new Emitter<LanguageConfigurationServiceChangeEvent>());
	readonly onDidChange = this.changeEmitter.event;

	constructor() {
		super();
		this._register(this.registry.onDidChange(event => {
			this.changeEmitter.fire(new LanguageConfigurationServiceChangeEvent(event.languageId));
		}));
	}

	public registerDefaults(): void {
		this._register(registerBuiltinLanguageConfigurations(this));
	}

	register(languageId: string, configuration: LanguageConfiguration, priority?: number): IDisposable {
		return this.registry.register(languageId, configuration, priority);
	}

	getLanguageConfiguration(languageId: string): ResolvedLanguageConfiguration {
		return this.registry.getLanguageConfiguration(languageId) ?? new ResolvedLanguageConfiguration(languageId, {});
	}
}

export function createTestLanguageConfigurationService(): TestLanguageConfigurationService {
	const service = new TestLanguageConfigurationService();
	service.registerDefaults();
	return service;
}
