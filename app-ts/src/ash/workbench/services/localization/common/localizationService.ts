import type { Event } from "../../../../base/common/event.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import type { LocalizationKey, LocalizationParameters } from "../../../../nls.js";

export type { LocalizationKey } from "../../../../nls.js";
export type { LocalizationParameters } from "../../../../nls.js";

export interface ILocalizationService {
	readonly onDidChange: Event<void>;
	readonly whenReady: Promise<void>;
	translate(bundle: string, key: string, fallback: string, parameters?: LocalizationParameters): string;
}

export const ILocalizationService = createServiceIdentifier<ILocalizationService>("localizationService");

export function localize(localization: ILocalizationService | undefined, key: LocalizationKey | undefined, fallback: string): string {
	return localization && key ? localization.translate(key.bundle, key.key, fallback) : fallback;
}
