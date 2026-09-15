/**
 * Electron renderer Workbench registrations.
 *
 * Add Electron-only services and contributions here. Registrations shared
 * with the browser host belong in `workbench.common.main.ts`.
 */
import "./workbench.common.main.js";
import "./electron-browser/desktop.contribution.js";
import "./contrib/browserView/electron-browser/browserView.contribution.js";
