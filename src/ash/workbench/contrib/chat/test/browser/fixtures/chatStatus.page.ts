import '../../../../../../base/browser/ui/styles.css';
import '../../../../../browser/media/style.css';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { lightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { setNlsMessages } from '../../../../../../nls.js';
import messages from '../../../../../../../../extensions/language-pack-zh-cn/translations/chat.json' with { type: 'json' };
import { createAppServerAccountApi, type BrowserAccountLoginHostServices } from '../../../../../../platform/accounts/browser/accountApi.js';
import { IAccountService } from '../../../../../../platform/accounts/common/accountService.js';
import type { AppServerProtocolClient } from '../../../../../../platform/agentHost/browser/appServerProtocolClient.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { StatusbarService } from '../../../../../browser/parts/statusbar/statusbarPart.js';
import { IStatusbarService, StatusbarAlignment } from '../../../../../services/statusbar/browser/statusbar.js';
import { AppServerAccountService } from '../../../../../services/accounts/browser/appServerAccountService.js';
import { ChatEntitlementService, IChatEntitlementService } from '../../../../../services/chat/common/chatEntitlementService.js';
import { TestNotificationService } from '../../../../../services/notification/test/common/testNotificationService.js';
import { ChatStatusBarEntry } from '../../../browser/chatStatus/chatStatusEntry.js';
import { decodeAppServerResponse } from '../../../../../../../../.build/protocol/typescript/AppServerProtocolDecoder.js';
import type { AppServerMethod } from '../../../../../../../../.build/protocol/typescript/index.js';

if (new URLSearchParams(location.search).has('zh')) { setNlsMessages('zh-CN', messages); }
const resources = new DisposableStore();
const services = resources.add(new InstantiationService());
const root = document.createElement('main');
root.className = 'ash-workbench';
root.style.height = '100vh';
document.body.append(root);
const theme = resources.add(new TestThemeService(lightColorTheme));
resources.add(bindTestColorTheme(theme, root));
const button = document.createElement('button');
root.append(button);
let queries = 0;
const connection = {
	async request(definition: { method: AppServerMethod; }): Promise<unknown> {
		let result: unknown;
		if (definition.method === 'account/read') {
			result = { revision: '1', accounts: [{ provider: 'chatgpt-subscription', accountId: 'synthetic', credentialRevision: '1', status: 'ready', displayName: 'Synthetic account', email: null, organization: null, plan: 'plus' }] };
		} else {
			queries++;
			document.documentElement.dataset.queries = String(queries);
			result = { provider: 'chatgpt-subscription', accountId: 'synthetic', plan: 'plus', credits: null,
				limits: [{ id: 'codex', name: 'Codex', model: null, allowed: true, limitReached: false,
					primary: { usedPercent: 25, windowSeconds: 18000, resetsAt: 1800000000 }, secondary: null }] };
		}
		return (decodeAppServerResponse(definition.method, { jsonrpc: '2.0', id: 1, result }) as { result: unknown; }).result;
	},
} as unknown as AppServerProtocolClient;
const accountApi = createAppServerAccountApi(connection, {} as BrowserAccountLoginHostServices);
services.registerInstance(IAccountService, resources.add(new AppServerAccountService(accountApi, { subscribe: Event.None })));
services.registerInstance(IConfigurationService, resources.add(new InMemoryConfigurationService()));
services.registerInstance(IChatEntitlementService, services.createInstance(ChatEntitlementService));
services.registerInstance(IQuickInputService, resources.add(new TestQuickInputService({ container: root })));
services.registerInstance(INotificationService, resources.add(new TestNotificationService()));
services.registerInstance(ICommandService, { executeCommand: async () => { throw new Error('Unexpected navigation'); } } as unknown as ICommandService);
const statusbar = resources.add(new StatusbarService());
services.registerInstance(IStatusbarService, statusbar);
resources.add(statusbar.onDidChangeEntries(() => {
	button.textContent = statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.text ?? '';
}));
const contribution = resources.add(services.createInstance(ChatStatusBarEntry));
button.onclick = () => statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.run?.();
contribution.onWorkspaceRestored();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
