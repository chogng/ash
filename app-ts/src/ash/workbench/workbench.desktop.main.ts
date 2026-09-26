/**
 * Electron renderer Workbench registrations.
 *
 * Add Electron-only services and contributions here. Registrations shared
 * with the browser host belong in `workbench.common.main.ts`.
 */
import "../platform/update/common/update.config.contribution.js";
import "./workbench.common.main.js";
import "./services/update/electron-browser/updateService.js";
import "./electron-browser/desktop.contribution.js";
import "./contrib/browserView/electron-browser/browserView.contribution.js";
import "./contrib/update/electron-browser/update.contribution.js";
