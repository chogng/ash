import type { IConfigurationPropertySchema } from '../../../platform/configuration/common/configurationRegistry.js';
import { terminalHistoryConfiguration } from '../terminalContrib/history/common/terminal.history.js';
import { terminalStickyScrollConfiguration } from '../terminalContrib/stickyScroll/common/terminalStickyScrollConfiguration.js';
import { terminalZoomConfiguration } from '../terminalContrib/zoom/common/terminal.zoom.js';
import { terminalResizeDimensionsOverlayConfiguration } from '../terminalContrib/resizeDimensionsOverlay/common/terminalResizeDimensionsOverlayConfiguration.js';
import { terminalCommandGuideConfiguration } from '../terminalContrib/commandGuide/common/terminalCommandGuideConfiguration.js';

import { terminalAutoRepliesConfiguration } from '../terminalContrib/autoReplies/common/terminalAutoRepliesConfiguration.js';
import { terminalOscNotificationsConfiguration } from '../terminalContrib/notification/common/terminalNotificationConfiguration.js';
import { terminalSuggestConfiguration } from '../terminalContrib/suggest/common/terminalSuggestConfiguration.js';
import { terminalTypeAheadConfiguration } from '../terminalContrib/typeAhead/common/terminalTypeAheadConfiguration.js';

/** Installed terminal enhancements contribute to the terminal's single configuration registration. */
export const terminalContribConfiguration: Readonly<Record<string, IConfigurationPropertySchema>> = Object.freeze({
	...terminalHistoryConfiguration,
	...terminalStickyScrollConfiguration,
	...terminalZoomConfiguration,
	...terminalResizeDimensionsOverlayConfiguration,
	...terminalCommandGuideConfiguration,
	...terminalAutoRepliesConfiguration,
	...terminalOscNotificationsConfiguration,
	...terminalTypeAheadConfiguration,
	...terminalSuggestConfiguration,
});
