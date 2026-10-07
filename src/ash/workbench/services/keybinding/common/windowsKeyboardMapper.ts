import { OperatingSystem } from '../../../../base/common/platform.js';
import type { IKeyboardMapperConfiguration, IKeyboardMapping } from '../../../../platform/keyboardLayout/common/keyboardLayout.js';
import { KeyboardMapper } from './keyboardMapper.js';

/** Windows mapper. Native `vkey` values remain attached to the raw mapping for diagnostics and host integration. */
export class WindowsKeyboardMapper extends KeyboardMapper {
	constructor(mapping: IKeyboardMapping, configuration: IKeyboardMapperConfiguration) {
		super(mapping, configuration, OperatingSystem.Windows);
	}

	public dumpDebugInfo(): string {
		const nativeKeys = Object.values(this.mapping).filter((entry) => entry.vkey).length;
		return this.dumpMappingTable(
			'WindowsKeyboardMapper',
			`Mapped keys: ${Object.keys(this.mapping).length}; native virtual keys: ${nativeKeys}`,
		);
	}
}
