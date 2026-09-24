import type { OperatingSystem } from '../../../../base/common/platform.js';
import type { IKeyboardMapperConfiguration } from '../../../../platform/keyboardLayout/common/keyboardLayout.js';
import { createUSKeyboardMapping } from './keyboardMapping.js';
import { KeyboardMapper } from './keyboardMapper.js';

/** Mapper used when neither the browser nor the desktop host can provide a layout. */
export class FallbackKeyboardMapper extends KeyboardMapper {
	constructor(configuration: IKeyboardMapperConfiguration, operatingSystem: OperatingSystem) {
		super(createUSKeyboardMapping(), configuration, operatingSystem);
	}

	public dumpDebugInfo(): string {
		return this.dumpMappingTable('FallbackKeyboardMapper', 'Using the built-in US fallback mapping.');
	}
}
