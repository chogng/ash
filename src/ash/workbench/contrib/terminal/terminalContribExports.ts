import type { IConfigurationPropertySchema } from '../../../platform/configuration/common/configurationRegistry.js';
import { terminalHistoryConfiguration } from '../terminalContrib/history/common/terminal.history.js';
import { terminalStickyScrollConfiguration } from '../terminalContrib/stickyScroll/common/terminalStickyScrollConfiguration.js';

/** Installed terminal enhancements contribute to the terminal's single configuration registration. */
export const terminalContribConfiguration: Readonly<Record<string, IConfigurationPropertySchema>> = Object.freeze({
	...terminalHistoryConfiguration,
	...terminalStickyScrollConfiguration,
});
