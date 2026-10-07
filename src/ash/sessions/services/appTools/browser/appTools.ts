import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { UpdateCheckResult } from '../../../../platform/update/common/updateService.js';
import type { SessionGroup } from '../../sessions/browser/sessionGroupsService.js';

/** Window-owned capabilities used by application tools; transport details stay in the adapter. */
export interface IAppToolsHost extends IDisposable {
	openFile(resource: URI, line?: number): Promise<void>;
	openReview(original: URI, modified: URI): Promise<void>;
	openBrowser(resource: URI): Promise<boolean>;
	openTerminal(signal: AbortSignal): Promise<string>;
	navigate(sessionId: string, threadId: string): Promise<void>;
	listSections(): readonly SessionGroup[];
	createSection(name: string, signal: AbortSignal): Promise<SessionGroup>;
	renameSection(sectionId: string, name: string, signal: AbortSignal): Promise<void>;
	deleteSection(sectionId: string, signal: AbortSignal): Promise<void>;
	moveSession(sessionId: string, sectionId: string | null, signal: AbortSignal): Promise<void>;
	reorderSection(sectionId: string, sessionIds: readonly string[], signal: AbortSignal): Promise<void>;
	checkUpdate(): Promise<UpdateCheckResult>;
	fireConfetti(): boolean;
	clearTransientState(): void;
}
