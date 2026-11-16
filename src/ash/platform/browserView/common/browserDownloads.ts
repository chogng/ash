import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export const BrowserDownloadDirectorySetting = 'workbench.browser.downloadDirectory';
export const BrowserDownloadAskSetting = 'workbench.browser.askBeforeDownload';
export const BrowserDownloadsChannel = 'browserDownloads';
export interface BrowserDownload {
	readonly id: string;
	readonly filename: string;
	readonly url: string;
	readonly path: string;
	readonly time: number;
	readonly receivedBytes: number;
	readonly totalBytes: number;
	readonly state: 'progressing' | 'completed' | 'cancelled' | 'interrupted' | 'deleted';
}
export interface BrowserDownloadState { readonly directory: string; readonly items: readonly BrowserDownload[]; }
export interface IBrowserDownloadService {
	readonly onDidChange: Event<void>;
	getState(): Promise<BrowserDownloadState>;
	configure(directory: string, ask: boolean): Promise<void>;
	chooseDirectory(): Promise<string | undefined>;
	perform(id: string, action: 'open' | 'show' | 'deleteFile' | 'remove'): Promise<void>;
}
export const IBrowserDownloadService = createServiceIdentifier<IBrowserDownloadService>('browserDownloadService');
