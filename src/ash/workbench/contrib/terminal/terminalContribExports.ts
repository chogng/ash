import type { IConfigurationPropertySchema } from '../../../platform/configuration/common/configurationRegistry.js';
import { terminalHistoryConfiguration } from '../terminalContrib/history/common/terminal.history.js';

/** Installed terminal enhancements contribute to the terminal's single configuration registration. */
export const terminalContribConfiguration: Readonly<Record<string, IConfigurationPropertySchema>> = Object.freeze({
	...terminalHistoryConfiguration,
});
