import { IRemoteTunnelService } from '../platform/remoteTunnel/common/remoteTunnel.js';
import { RemoteTunnelService } from '../platform/remoteTunnel/electron-browser/remoteTunnelService.js';
import { ElectronElevatedFileService } from './services/files/electron-browser/elevatedFileService.js';
import { IElevatedFileService } from './services/files/common/elevatedFileService.js';
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
import { IRemoteAuthorityResolverService } from '../platform/remote/common/remoteAuthorityResolver.js';
import { RemoteAuthorityResolverService } from '../platform/remote/electron-browser/remoteAuthorityResolverService.js';
import { IIntegrityService } from './services/integrity/common/integrity.js';
import { IntegrityService } from './services/integrity/electron-browser/integrityService.js';
import "./electron-browser/desktop.contribution.js";
import './contrib/workspace/browser/workspace.contribution.js';
import "./contrib/browserView/electron-browser/browserView.contribution.js";
import "./contrib/update/electron-browser/update.contribution.js";

import { ITunnelService } from '../platform/tunnel/common/tunnel.js';
import { TunnelService } from './services/tunnel/electron-browser/tunnelService.js';

registerSingleton(IHostService, NativeHostService, InstantiationType.Delayed);
registerSingleton(ILanguagePackStore, ElectronLanguagePackStore, InstantiationType.Delayed);
registerSingleton(IIntegrityService, IntegrityService, InstantiationType.Delayed);

registerSingleton(IElevatedFileService, ElectronElevatedFileService, InstantiationType.Delayed);

registerSingleton(ITunnelService, TunnelService, InstantiationType.Delayed);
registerSingleton(IRemoteAuthorityResolverService, RemoteAuthorityResolverService, InstantiationType.Delayed);

registerSingleton(IRemoteTunnelService, RemoteTunnelService, InstantiationType.Delayed);
import './contrib/remoteTunnel/electron-browser/remoteTunnel.contribution.js';
