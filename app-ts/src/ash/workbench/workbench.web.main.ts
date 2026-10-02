/**
 * Browser-hosted Workbench registrations.
 *
 * Add browser-only services and contributions here. Registrations shared with
 * Electron belong in `workbench.common.main.ts`.
 */
import "./workbench.common.main.js";
import './services/workspaces/browser/workspacesService.js';
import { BrowserHostService } from './services/host/browser/browserHostService.js';
import { IHostService } from './services/host/browser/host.js';
import { InstantiationType, registerSingleton } from '../platform/instantiation/common/extensions.js';

registerSingleton(IHostService, BrowserHostService, InstantiationType.Delayed);
