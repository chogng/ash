// The preview uses production chrome and editor registrations without loading
// the entire Web product (terminal add-ons, tasks, testing and extension hosts).
// Keep this as one import boundary after the preview host initializes NLS.
import '../../../browser/workbench.contribution.js';
import '../../../browser/actions/layoutActions.js';
import '../../modernUI/browser/modernUI.contribution.js';
import '../../codeEditor/browser/codeEditor.contribution.js';
import '../../folding/browser/folding.contribution.js';
import '../../snippets/browser/snippets.contribution.js';
import '../../logs/common/logs.contribution.js';
import '../../debug/browser/debugAdapterManager.js';
import '../../terminal/common/terminalExtensionPoints.contribution.js';
import '../../bulkEdit/browser/bulkEditService.js';
import '../../../services/dialogs/common/dialogService.js';
import '../../../services/path/browser/pathService.js';
import '../../../services/dataChannel/browser/dataChannelService.js';
import '../../../services/configurationResolver/browser/configurationResolverService.js';
import '../../../services/workspaces/browser/workspacesService.js';
import '../../../services/workspaces/browser/workspaceEditingService.js';
import '../../../../editor/editor.code.all.js';
import '../../../../platform/uriIdentity/common/uriIdentityService.js';
import '../../../../platform/meteredConnection/browser/meteredConnectionService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { BrowserHostService } from '../../../services/host/browser/browserHostService.js';
import { IRemoteAuthorityResolverService } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { RemoteAuthorityResolverService } from '../../../../platform/remote/browser/remoteAuthorityResolverService.js';
import { IWebWorkerService } from '../../../../platform/webWorker/browser/webWorkerService.js';
import { WebWorkerService } from '../../../../platform/webWorker/browser/webWorkerServiceImpl.js';
import { ILanguagePackStore } from '../../../../platform/languagePacks/common/languagePackStore.js';
import { BrowserLanguagePackStore } from '../../../../platform/languagePacks/browser/languagePackStore.js';
import { IUpdateService } from '../../../../platform/update/common/updateService.js';
import { BrowserUpdateService } from '../../../services/update/browser/updateService.js';
import { IElevatedFileService } from '../../../services/files/common/elevatedFileService.js';
import { BrowserElevatedFileService } from '../../../services/files/browser/elevatedFileService.js';
import { IAccessibilitySignalService, AccessibilitySignalService } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';

registerSingleton(IHostService, new SyncDescriptor(BrowserHostService, [{}], true));
registerSingleton(IRemoteAuthorityResolverService, RemoteAuthorityResolverService, InstantiationType.Delayed);
registerSingleton(IWebWorkerService, WebWorkerService, InstantiationType.Delayed);
registerSingleton(ILanguagePackStore, BrowserLanguagePackStore, InstantiationType.Delayed);
registerSingleton(IUpdateService, BrowserUpdateService, InstantiationType.Delayed);
registerSingleton(IElevatedFileService, BrowserElevatedFileService, InstantiationType.Delayed);
registerSingleton(IAccessibilitySignalService, AccessibilitySignalService, InstantiationType.Delayed);
