import type { IDisposable } from '../../../base/common/lifecycle.js';
import { autorun, observableFromEvent, type IObservable, type IReader } from '../../../base/common/observable.js';
import type { IConfigurationService } from '../../configuration/common/configuration.js';
import { type ContextKeyValue, type IContextKeyService, RawContextKey } from '../../contextkey/common/contextkey.js';

export function observableConfigValue<T>(key: string, defaultValue: T, configurationService: IConfigurationService): IObservable<T> {
	return observableFromEvent(key, listener => configurationService.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(key)) {
			listener(event);
		}
	}), () => configurationService.getValue<T>(key) ?? defaultValue);
}

/** The caller owns the binding for as long as it owns the computed state. */
export function bindContextKey<T extends ContextKeyValue>(key: RawContextKey<T>, service: IContextKeyService, computeValue: (reader: IReader) => T): IDisposable {
	const boundKey = key.bindTo(service);
	return autorun(reader => boundKey.set(computeValue(reader)));
}
