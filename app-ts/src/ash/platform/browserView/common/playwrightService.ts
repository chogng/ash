import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { BrowserViewAction, IBrowserViewObservation, IBrowserViewObservationOptions } from './browserView.js';

export const IPlaywrightService = createServiceIdentifier<IPlaywrightService>('playwrightService');
/** Desktop automation lives in the shared process; every call is scoped to a real Thread. */
export interface IPlaywrightService {
	getObservation(operationId: string, sessionId: string, pageId: string, options: IBrowserViewObservationOptions): Promise<IBrowserViewObservation>;
	performAction(operationId: string, sessionId: string, pageId: string, action: BrowserViewAction): Promise<void>;
	/** Cancels the operation between Chromium commands; the original promise remains its completion barrier. */
	cancelOperation(operationId: string): Promise<void>;
	disposeSession(sessionId: string): Promise<void>;
}
