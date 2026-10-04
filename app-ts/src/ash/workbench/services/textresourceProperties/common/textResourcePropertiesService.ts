import type { URI } from '../../../../base/common/uri.js';
import { isLinux, isMacintosh } from '../../../../base/common/platform.js';
import { ITextResourcePropertiesService } from '../../../../editor/common/services/textResourceConfiguration.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

export class TextResourcePropertiesService implements ITextResourcePropertiesService {
	declare public readonly _serviceBrand: undefined;

	constructor(@IConfigurationService private readonly configuration: IConfigurationService) {}

	public getEOL(resource: URI, language?: string): string {
		const value = this.configuration.getValue<'auto' | '\n' | '\r\n'>('files.eol', { resource, overrideIdentifier: language });
		if (value === 'auto') {
			return isLinux || isMacintosh ? '\n' : '\r\n';
		}
		return value;
	}
}
