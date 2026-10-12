import type { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { Snippet } from './snippetsFile.js';

export const ISnippetsService = createDecorator<ISnippetsService>('snippetService');

/** Owns the active snippet definitions independently of their completion consumers. */
export interface ISnippetsService {
	readonly onDidChange: Event<void>;
	getSnippetsSync(languageId: string): Snippet[];
}
