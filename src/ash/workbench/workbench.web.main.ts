import { IRemoteTunnelService } from '../platform/remoteTunnel/common/remoteTunnel.js';
import { BrowserRemoteTunnelService } from '../platform/remoteTunnel/browser/remoteTunnelService.js';
import { BrowserElevatedFileService } from './services/files/browser/elevatedFileService.js';
import { IElevatedFileService } from './services/files/common/elevatedFileService.js';
/**
 * Browser-hosted Workbench registrations.
 *
 * Add browser-only services and contributions here. Registrations shared with
 * Electron belong in `workbench.common.main.ts`.
 */
import "./workbench.common.main.js";
import './services/tunnel/browser/tunnelService.js';
import './services/workspaces/browser/workspacesService.js';
import { BrowserHostService } from './services/host/browser/browserHostService.js';
import { IHostService } from './services/host/browser/host.js';
import { InstantiationType, registerSingleton } from '../platform/instantiation/common/extensions.js';
import { ILanguagePackStore } from '../platform/languagePacks/common/languagePackStore.js';
import { BrowserLanguagePackStore } from '../platform/languagePacks/browser/languagePackStore.js';
import { IIssueFormService } from './contrib/issue/common/issue.js';
import { IssueFormService } from './contrib/issue/browser/issueFormService.js';
import { IRemoteAuthorityResolverService } from '../platform/remote/common/remoteAuthorityResolver.js';
import { RemoteAuthorityResolverService } from '../platform/remote/browser/remoteAuthorityResolverService.js';

import { ITunnelService } from '../platform/tunnel/common/tunnel.js';
import { TunnelService } from './services/tunnel/browser/tunnelService.js';

registerSingleton(IHostService, BrowserHostService, InstantiationType.Delayed);
registerSingleton(ILanguagePackStore, BrowserLanguagePackStore, InstantiationType.Delayed);
registerSingleton(IIssueFormService, IssueFormService, InstantiationType.Delayed);

registerSingleton(IElevatedFileService, BrowserElevatedFileService, InstantiationType.Delayed);

registerSingleton(ITunnelService, TunnelService, InstantiationType.Delayed);
registerSingleton(IRemoteAuthorityResolverService, RemoteAuthorityResolverService, InstantiationType.Delayed);

registerSingleton(IRemoteTunnelService, BrowserRemoteTunnelService, InstantiationType.Delayed);
