import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { IResourceApi } from '../../agentHost/common/appServerApi.js';
import type { IFileReadSnapshot } from '../../files/common/files.js';

export interface PdfRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number; }
export interface PdfPoint { readonly x: number; readonly y: number; }
export interface PdfCharacter { readonly text: string; readonly bounds: PdfRect; }
export interface PdfAnnotation { readonly index: number; readonly kind: string; readonly contents: string; readonly author: string; readonly bounds: PdfRect; }
export type PdfAnnotationEdit =
	| { readonly kind: 'highlight' | 'note' | 'text'; readonly bounds: PdfRect; readonly contents: string; }
	| { readonly kind: 'ink'; readonly points: readonly PdfPoint[]; }
	| { readonly kind: 'update'; readonly index: number; readonly contents: string; }
	| { readonly kind: 'delete'; readonly index: number; };

export interface PdfPage {
	readonly revision: number;
	readonly sha256: string;
	readonly pageCount: number;
	readonly page: number;
	readonly width: number;
	readonly height: number;
	readonly widthPoints: number;
	readonly heightPoints: number;
	readonly text: string;
	readonly textTruncated: boolean;
	readonly characters: readonly PdfCharacter[];
	readonly annotations: readonly PdfAnnotation[];
	readonly annotationsTruncated: boolean;
	readonly imageSize: number;
	readonly imageSha256: string;
	readonly fileSize: number;
}

/** One editor owns the working PDF snapshot; saving still belongs to the file/working-copy owner. */
export interface IPdfDocument extends IDisposable {
	page(page: number, dimension: number, signal: AbortSignal, edit?: PdfAnnotationEdit): Promise<PdfPage>;
	image(page: PdfPage, signal: AbortSignal): Promise<Uint8Array>;
	export(page: PdfPage, signal: AbortSignal): Promise<Uint8Array>;
}

export const IPdfService = createServiceIdentifier<IPdfService>('pdfService');
export interface IPdfService {
	open(bytes: Uint8Array, signal: AbortSignal): Promise<IPdfDocument>;
	openSnapshot?(acquire: (owner: IResourceApi) => Promise<IFileReadSnapshot | undefined>, signal: AbortSignal): Promise<{ document: IPdfDocument; revision: string; } | undefined>;
}
