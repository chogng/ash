import './contrib/memories/browser/memories.contribution.js';
import './contrib/memory/browser/memory.contribution.js';
/**
 * Shared Workbench registrations loaded by every renderer host.
 *
 * Host-specific services and contributions belong in `workbench.web.main.ts`
 * or `workbench.desktop.main.ts`, while product entries remain responsible
 * for selecting their editor contributions.
 */
import "./browser/workbench.contribution.js";
import "./contrib/modernUI/browser/modernUI.contribution.js";

import './contrib/marketplace/browser/marketplace.contribution.js';
import './contrib/language/browser/languageServers.contribution.js';
import './contrib/skills/browser/skills.contribution.js';
