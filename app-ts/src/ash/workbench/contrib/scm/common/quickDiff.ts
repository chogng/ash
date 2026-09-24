import { type Event } from '../../../../base/common/event.js';
import { type IDisposable } from '../../../../base/common/lifecycle.js';
import { type URI } from '../../../../base/common/uri.js';
import { type DiffModel } from '../../../../editor/common/diff/diffModel.js';
import { type LineDiffKind } from '../../../../editor/common/diff/lineDiff.js';
import { type TextModel } from '../../../../editor/common/model/textModel.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

/** Immutable provider result used as the original side of one live Quick Diff comparison. */
export interface QuickDiffOriginalResource {
	readonly providerId: string;
	readonly providerLabel: string;
	readonly label: string;
	readonly originalResource: URI;
	readonly revision: string | number;
	readonly text: string;
}

/** Supplies an original resource for a working resource, independently of Git. */
export interface QuickDiffProvider {
	readonly id: string;
	readonly label: string;
	readonly rootUri?: URI;
	readonly onDidChange?: Event<URI | undefined>;
	provideOriginalResource(resource: URI, signal: AbortSignal): Promise<QuickDiffOriginalResource | undefined>;
}

export interface IQuickDiffService extends IDisposable {
	readonly onDidChange: Event<URI | undefined>;
	readonly providers: readonly QuickDiffProvider[];
	addProvider(provider: QuickDiffProvider): IDisposable;
	isProviderVisible(providerId: string): boolean;
	setProviderVisible(providerId: string, visible: boolean): void;
	getQuickDiffs(resource: URI, signal: AbortSignal): Promise<readonly QuickDiffOriginalResource[]>;
}

export const IQuickDiffService = createServiceIdentifier<IQuickDiffService>('quickDiffService');

export interface QuickDiffComparison {
	readonly original: QuickDiffOriginalResource;
	readonly model: DiffModel;
}

export interface QuickDiffChange {
	readonly id: string;
	readonly comparison: QuickDiffComparison;
	readonly kind: Exclude<LineDiffKind, LineDiffKind.Unchanged>;
	readonly rowStart: number;
	readonly rowEnd: number;
	readonly originalStartLineIndex: number;
	readonly originalLineCount: number;
	readonly modifiedStartLineIndex: number;
	readonly modifiedLineCount: number;
	readonly lineIndex: number;
}

export interface QuickDiffModelState {
	readonly loading: boolean;
	readonly comparisons: readonly QuickDiffComparison[];
	readonly changes: readonly QuickDiffChange[];
}

export interface IQuickDiffModel {
	readonly onDidChange: Event<QuickDiffModelState>;
	readonly state: QuickDiffModelState;
	findChangeAtLine(lineIndex: number): QuickDiffChange | undefined;
	findNextChange(lineIndex: number, inclusive?: boolean): QuickDiffChange | undefined;
	findPreviousChange(lineIndex: number, inclusive?: boolean): QuickDiffChange | undefined;
}

export interface QuickDiffModelReference extends IDisposable {
	readonly object: IQuickDiffModel;
}

export interface IQuickDiffModelService extends IDisposable {
	createModelReference(resource: URI, model: TextModel): QuickDiffModelReference;
}

export const IQuickDiffModelService = createServiceIdentifier<IQuickDiffModelService>('quickDiffModelService');

export interface IQuickDiffEditorController {
	showNextChange(): void;
	showPreviousChange(): void;
	close(): void;
}

export interface IQuickDiffEditorControllerService extends IDisposable {
	readonly activeController: IQuickDiffEditorController | undefined;
	register(controller: IQuickDiffEditorController): IDisposable;
	activate(controller: IQuickDiffEditorController): void;
}

export const IQuickDiffEditorControllerService = createServiceIdentifier<IQuickDiffEditorControllerService>('quickDiffEditorControllerService');
