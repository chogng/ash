import type { INativeHostApi, IOpenAgentsWindowOptions } from '../../../../../platform/native/common/nativeHost.js';
import type { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';

export async function continueChatInAgentsWindow(
	host: Pick<INativeHostApi, 'openAgentsWindow'>,
	conversation: IOpenAgentsWindowOptions['conversation'],
	captured: Awaited<ReturnType<IChatSessionNavigationService['captureActiveDraft']>>,
): Promise<void> {
	await host.openAgentsWindow(conversation || captured ? { conversation, draft: captured?.draft } : undefined);
	// The source still owns the draft until the target window acknowledges receipt.
	captured?.clear();
}
