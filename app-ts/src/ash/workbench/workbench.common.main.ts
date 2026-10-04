import './contrib/memories/browser/memories.contribution.js';
import './contrib/memory/browser/memory.contribution.js';
import './contrib/trace/browser/trace.contribution.js';
import './contrib/issue/browser/issue.contribution.js';
import './services/dialogs/common/dialogService.js';
import './services/dataChannel/browser/dataChannelService.js';
import './api/browser/mainThreadDataChannels.contribution.js';
import './contrib/bulkEdit/browser/bulkEditService.js';
/**
 * Shared Workbench registrations loaded by every renderer host.
 *
 * Host-specific services and contributions belong in `workbench.web.main.ts`
 * or `workbench.desktop.main.ts`, while product entries remain responsible
 * for selecting their editor contributions.
 */
import "./browser/workbench.contribution.js";
import "./contrib/modernUI/browser/modernUI.contribution.js";
import './contrib/mediaPreview/browser/mediaPreview.contribution.js';

import './contrib/marketplace/browser/marketplace.contribution.js';
import './contrib/language/browser/languageServers.contribution.js';
import './contrib/localization/common/localization.contribution.js';
import './contrib/authentication/browser/authentication.contribution.js';
import './contrib/skills/browser/skills.contribution.js';
import './contrib/onboarding/browser/onboarding.contribution.js';
import './browser/parts/titlebar/commandCenterOnboarding.contribution.js';
import './contrib/update/browser/update.contribution.js';

import './contrib/output/browser/output.contribution.js';
