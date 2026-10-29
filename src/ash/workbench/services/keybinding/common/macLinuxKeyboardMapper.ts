import type { OperatingSystem } from '../../../../base/common/platform.js';
import type { IKeyboardMapperConfiguration, IKeyboardMapping } from '../../../../platform/keyboardLayout/common/keyboardLayout.js';
import { KeyboardMapper } from './keyboardMapper.js';

/** Scan-code mapper shared by macOS and Linux, including dead-key and AltGr mapping states. */
export class MacLinuxKeyboardMapper extends KeyboardMapper {
	constructor(mapping: IKeyboardMapping, configuration: IKeyboardMapperConfiguration, operatingSystem: OperatingSystem) {
		super(mapping, configuration, operatingSystem);
	}

	public dumpDebugInfo(): string {
		const deadKeys = Object.values(this.mapping).filter((entry) =>
			entry.valueIsDeadKey || entry.withShiftIsDeadKey || entry.withAltGrIsDeadKey || entry.withShiftAltGrIsDeadKey
		).length;
		return this.dumpMappingTable(
			'MacLinuxKeyboardMapper',
			`Mapped keys: ${Object.keys(this.mapping).length}; keys with dead states: ${deadKeys}`,
		);
	}
}
