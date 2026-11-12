import { localize } from '../../../../nls.js';
import { registerAccountProviderLabel } from '../../../../platform/accounts/common/accountService.js';

registerAccountProviderLabel('chatgpt-web', () => localize({ bundle: 'ash', key: 'workbench.chatgptWebAccount' }, 'ChatGPT Web'));
