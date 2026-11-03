import { addDisposableListener } from '../../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { formatNlsMessage, setNlsResolver } from '../../../../../../nls.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../../platform/dialogs/common/dialogs.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { BrowserDialogHandler } from '../../../../../browser/parts/dialogs/dialog.js';
import { DialogHandlerContribution } from '../../../../../browser/parts/dialogs/dialog.web.contribution.js';
import { DialogService } from '../../../../../services/dialogs/common/dialogService.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { productLanguagePackCatalogs } from '../../../../../services/localization/common/localizationCatalogs.js';
import { IAppServerRemoteAgentService } from '../../../../../services/remote/common/appServerRemoteAgentService.js';
import { NEW_AGENT_COMMAND_ID, NEW_INSTRUCTIONS_COMMAND_ID, registerNewPromptFileActions } from '../../../browser/promptSyntax/newPromptFileActions.js';

const lifetime = new DisposableStore();
if (new URLSearchParams(location.search).get('locale') === 'zh-CN') {
	const catalog = productLanguagePackCatalogs.find(value => value.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, values) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, values));
}
const services = lifetime.add(new InstantiationService());
const files = lifetime.add(new FileService());
lifetime.add(files.registerProvider('memory', lifetime.add(new InMemoryFileSystemProvider())));
services.registerInstance(IFileService, files);
const workspace = { id: 'creation', folders: [{ id: 'root', name: 'project', index: 0, uri: URI.parse('memory:/project') }] };
services.registerInstance(IWorkspaceContextService, { getWorkspace: () => workspace } as unknown as IWorkspaceContextService);
services.registerInstance(IConfigurationService, { getValue: () => false } as unknown as IConfigurationService);
services.registerInstance(IAppServerRemoteAgentService, { connection: undefined } as IAppServerRemoteAgentService);
const status = document.querySelector<HTMLElement>('[role=status]')!;
services.registerInstance(INotificationService, { info: (message: string) => { status.textContent = message; } } as unknown as INotificationService);
const quickInput = lifetime.add(new TestQuickInputService({ container: document.body }));
services.registerInstance(IQuickInputService, quickInput);
const dialogs = lifetime.add(new DialogService());
services.registerInstance(IDialogService, dialogs);
lifetime.add(new DialogHandlerContribution(dialogs.model, new BrowserDialogHandler(document.body)));
services.registerInstance(IEditorService, {
	async openEditor(input: { resource: URI; }) {
		status.textContent = `${input.resource.toString()}\n${(await files.readFile(input.resource)).content}`;
	},
} as unknown as IEditorService);
lifetime.add(registerNewPromptFileActions());
for (const [selector, command] of [['#agent', NEW_AGENT_COMMAND_ID], ['#instructions', NEW_INSTRUCTIONS_COMMAND_ID]]) {
	lifetime.add(addDisposableListener(document.querySelector(selector)!, 'click', () => {
		void Promise.resolve(services.invokeFunction(CommandsRegistry.getCommand(command)!)).catch(error => { status.textContent = String(error); });
	}));
}
lifetime.add(addDisposableListener(window, 'pagehide', () => lifetime.dispose(), { once: true }));
