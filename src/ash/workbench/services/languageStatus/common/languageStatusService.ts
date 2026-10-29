import { Event } from '../../../../base/common/event.js';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type Severity from '../../../../base/common/severity.js';
import { LanguageFeatureRegistry } from '../../../../editor/common/languageFeatureRegistry.js';
import type { LanguageSelector } from '../../../../editor/common/languageSelector.js';
import type { Command } from '../../../../editor/common/languages.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import type { IAccessibilityInformation } from '../../../../platform/accessibility/common/accessibility.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export interface ILanguageStatus {
	readonly id: string;
	readonly name: string;
	readonly selector: LanguageSelector;
	readonly severity: Severity;
	readonly label: string | { value: string; shortValue: string };
	readonly detail: string;
	readonly busy: boolean;
	readonly source: string;
	readonly command: Command | undefined;
	readonly accessibilityInfo: IAccessibilityInformation | undefined;
}

export const ILanguageStatusService = createDecorator<ILanguageStatusService>('ILanguageStatusService');

export interface ILanguageStatusService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	addStatus(status: ILanguageStatus): IDisposable;
	getLanguageStatus(model: ITextModel): ILanguageStatus[];
}

/** Window-owned registrations use the same selector matching as language providers. */
class LanguageStatusService extends Disposable implements ILanguageStatusService {
	readonly _serviceBrand = undefined;
	private readonly statuses = this._register(new LanguageFeatureRegistry<ILanguageStatus>());
	readonly onDidChange = Event.map(this.statuses.onDidChange, () => undefined);

	addStatus(status: ILanguageStatus): IDisposable {
		return this.statuses.register(status.selector, status);
	}

	getLanguageStatus(model: ITextModel): ILanguageStatus[] {
		return this.statuses.ordered(model).sort((a, b) => b.severity - a.severity || a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
	}
}

registerSingleton(ILanguageStatusService, LanguageStatusService, InstantiationType.Delayed);
