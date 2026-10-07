/**
 * Electron renderer Workbench registrations.
 *
 * Add Electron-only services and contributions here. Registrations shared
 * with the browser host belong in `workbench.common.main.ts`.
 */
import "../platform/update/common/update.config.contribution.js";
import "./workbench.common.main.js";
import "./services/update/electron-browser/updateService.js";
import './services/workspaces/electron-browser/workspacesService.js';
import './contrib/chat/electron-browser/chat.contribution.js';
import { NativeHostService } from './services/host/electron-browser/nativeHostService.js';
import { IHostService } from './services/host/browser/host.js';
import { InstantiationType, registerSingleton } from '../platform/instantiation/common/extensions.js';
import { ILanguagePackStore } from '../platform/languagePacks/common/languagePackStore.js';
import { ElectronLanguagePackStore } from '../platform/languagePacks/electron-browser/languagePackStore.js';
import { IIntegrityService } from './services/integrity/common/integrity.js';
import { IntegrityService } from './services/integrity/electron-browser/integrityService.js';
import "./electron-browser/desktop.contribution.js";
import './contrib/workspace/browser/workspace.contribution.js';
import "./contrib/browserView/electron-browser/browserView.contribution.js";
import "./contrib/update/electron-browser/update.contribution.js";

registerSingleton(IHostService, NativeHostService, InstantiationType.Delayed);
registerSingleton(ILanguagePackStore, ElectronLanguagePackStore, InstantiationType.Delayed);
registerSingleton(IIntegrityService, IntegrityService, InstantiationType.Delayed);
