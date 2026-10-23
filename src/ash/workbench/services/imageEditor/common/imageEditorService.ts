import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { VSBuffer } from '../../../../base/common/buffer.js';

export interface CodeImageSnapshot {
	readonly title: string;
	readonly firstLine: number;
	readonly lines: readonly (readonly { readonly text: string; readonly color: string; readonly italic: boolean; readonly bold: boolean; readonly underline: boolean; readonly strikethrough: boolean; }[])[];
	readonly background: string;
	readonly foreground: string;
	readonly fontFamily: string;
	readonly fontSize: number;
	readonly tabSize: number;
}
export interface ImageEditorView { readonly html: string; readonly state?: unknown; }
export interface ImageEditorProvider {
	readonly id: string;
	readonly displayName: string;
	readonly default: boolean;
	readonly accessibilityHelp: string;
	readonly signal: AbortSignal;
	resolve(source: 'screen' | 'selection', signal: AbortSignal): Promise<ImageEditorView>;
}
export interface ImageEditorOptions {
	readonly editorId?: string;
	readonly code?: CodeImageSnapshot;
	/** Chat-originated captures attach on Enter; standalone images copy on Enter. */
	readonly defaultAction?: 'attach' | 'copy';
}
/** The destination owns its draft and lends cancellation to this producer. */
export type ImageEditorCapture = (signal: AbortSignal) => Promise<VSBuffer | undefined>;
/** One registration owner; platform capture adapters borrow providers for individual interactions. */
export interface IImageEditorService {
	readonly onDidChange: Event<void>;
	readonly available: boolean;
	readonly accessibilityHelp: string;
	register(provider: ImageEditorProvider): IDisposable;
	resolve(source: 'screen' | 'selection', signal: AbortSignal, id?: string): Promise<{ readonly view: ImageEditorView; readonly displayName: string; readonly signal: AbortSignal; }>;
	capture(signal: AbortSignal, options?: ImageEditorOptions): Promise<VSBuffer | undefined>;
	show(options: ImageEditorOptions, signal: AbortSignal): Promise<void>;
	registerAttachmentHandler(handler: (capture: ImageEditorCapture) => Promise<void>): IDisposable;
}
export const IImageEditorService = createServiceIdentifier<IImageEditorService>('imageEditorService');
