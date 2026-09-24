import { addDisposableListener } from '../../../src/ash/base/browser/dom.js';
import { CancellationToken, CancellationTokenSource } from '../../../src/ash/base/common/cancellation.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { DiffEditorWidget } from '../../../src/ash/editor/browser/widget/diffEditor/diffEditorWidget.js';
import '../../../src/ash/editor/contrib/diffEditorBreadcrumbs/browser/contribution.js';
import { StandaloneServices } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { MultiDiffEditorWidget } from '../../../src/ash/editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.js';
import { DocumentDiffItem, MultiDiffEditorModel } from '../../../src/ash/editor/browser/widget/multiDiffEditor/model.js';
import { DiffModel } from '../../../src/ash/editor/common/diff/diffModel.js';
import { toLineDiff } from '../../../src/ash/editor/common/diff/lineDiff.js';
import { Range } from '../../../src/ash/editor/common/core/range.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { DiffService } from '../../../src/ash/workbench/services/diff/browser/diffService.js';
import { QuickDiffModelService } from '../../../src/ash/workbench/contrib/scm/browser/quickDiffModel.js';
import { ScmConfiguration } from '../../../src/ash/workbench/contrib/scm/common/scmConfiguration.js';
import { WorkbenchQuickDiffService } from '../../../src/ash/workbench/contrib/scm/browser/workbenchQuickDiffService.js';
import { CodeEditorConfiguration } from '../../../src/ash/workbench/contrib/codeEditor/common/editorConfiguration.js';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../src/ash/nls.js';
import { builtinLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';

const resources = new DisposableStore();
const editorServices = StandaloneServices.initialize();
resources.add(toDisposable(resetNlsResolver));
const symbolProvider = resources.add(editorServices.languageFeaturesService.documentSymbolProvider.register('*', {
	provideDocumentSymbols: request => request.model.getLineCount() < 36 ? [] : [{
		name: 'Shared section',
		kind: 'function',
		range: new Range(5, 1, 36, 2),
		selectionRange: new Range(5, 1, 5, 2),
	}],
}));
const diffOptions = { ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: false };
const service = new DiffService();
const computation = resources.add(service.createComputationService());
const original = resources.add(new TextModel('same\nbefore 😀 after\nlast'));
const modified = resources.add(new TextModel('same\nbefore 🤖 after\nlast'));
const model = resources.add(new DiffModel({ original, modified, diffProvider: computation, diffOptions }));
const secondOriginal = resources.add(new TextModel('one\n'));
const secondModified = resources.add(new TextModel('one'));
const second = resources.add(new DiffModel({ original: secondOriginal, modified: secondModified, diffProvider: computation, diffOptions }));
const single = resources.add(editorServices.createInstance(DiffEditorWidget, { container: document.getElementById('single')!, model }));
resources.add(editorServices.createInstance(MultiDiffEditorWidget, {
	container: document.getElementById('multi')!,
	model: resources.add(new MultiDiffEditorModel([
		resources.add(new DocumentDiffItem({ id: 'first', label: 'first.ts' }, model)),
		resources.add(new DocumentDiffItem({ id: 'second', label: 'second.ts' }, second)),
	])),
}));
const input = document.getElementById('modified') as HTMLTextAreaElement;
input.value = modified.getText();
resources.add(addDisposableListener(input, 'input', () => modified.setValue(input.value)));

let baselineRequests = 0;
const baselines = resources.add(new WorkbenchQuickDiffService());
resources.add(baselines.addProvider({
	id: 'test', label: 'Index',
	async provideOriginalResource(resource) {
		baselineRequests++;
		return { providerId: 'test', providerLabel: 'Index', label: 'Index', originalResource: resource, revision: 1, text: original.getText() };
	},
}));
const configuration = resources.add(new InMemoryConfigurationService());
const quickDiff = resources.add(new QuickDiffModelService(baselines, service, configuration));
const reference = resources.add(quickDiff.createModelReference(URI.file('/workspace/first.ts'), modified));
let activeManyActions = 0;
const lazyLoads: number[] = [];
let dynamicResources: DisposableStore | undefined;
let dynamicCollection: MultiDiffEditorModel | undefined;
let dynamicSecond: DocumentDiffItem | undefined;
let completeDeferredComparison: (() => void) | undefined;
let compressedEditor: MultiDiffEditorWidget | undefined;
let compressedViewState: unknown;

const harness = {
	showManyComparisons(count: number): void {
		const manyResources = resources.add(new DisposableStore());
		manyResources.add(editorServices.createInstance(MultiDiffEditorWidget, {
			container: document.getElementById('many')!,
			model: manyResources.add(new MultiDiffEditorModel(Array.from({ length: count }, (_, index) => manyResources.add(new DocumentDiffItem({ id: `file-${index}`, label: `file-${index}.ts` }, model))))),
			workbenchUIElementFactory: { createItemActions: () => {
				activeManyActions++;
				return toDisposable(() => activeManyActions--);
			} },
		}));
	},
	showLazyComparisons(count: number): void {
		const lazyResources = resources.add(new DisposableStore());
		lazyResources.add(editorServices.createInstance(MultiDiffEditorWidget, {
			container: document.getElementById('many')!,
			model: lazyResources.add(new MultiDiffEditorModel(Array.from({ length: count }, (_, index) => lazyResources.add(new DocumentDiffItem(
				{ id: `lazy-${index}`, label: `lazy-${index}.ts` },
				async () => {
					lazyLoads.push(index);
					return model;
				},
			))))),
		}));
	},
	get lazyLoads(): readonly number[] {
		return lazyLoads;
	},
	showDynamicComparisons(): void {
		dynamicResources = resources.add(new DisposableStore());
		const firstItem = dynamicResources.add(new DocumentDiffItem({ id: 'dynamic-first', label: 'dynamic-first.ts' }, model));
		dynamicSecond = dynamicResources.add(new DocumentDiffItem({ id: 'dynamic-second', label: 'dynamic-second.ts' }, second));
		dynamicCollection = dynamicResources.add(new MultiDiffEditorModel([firstItem, dynamicSecond]));
		dynamicResources.add(editorServices.createInstance(MultiDiffEditorWidget, {
			container: document.getElementById('many')!,
			model: dynamicCollection,
		}));
	},
	updateDynamicComparisons(): void {
		const third = dynamicResources!.add(new DocumentDiffItem({ id: 'dynamic-third', label: 'dynamic-third.ts' }, model));
		dynamicCollection!.setItems([dynamicSecond!, third]);
	},
	showDeferredComparison(): void {
		const deferredResources = resources.add(new DisposableStore());
		const item = deferredResources.add(new DocumentDiffItem({ id: 'deferred', label: 'deferred.ts' }, () => new Promise(resolve => {
			completeDeferredComparison = () => resolve(model);
		})));
		deferredResources.add(editorServices.createInstance(MultiDiffEditorWidget, {
			container: document.getElementById('many')!,
			model: deferredResources.add(new MultiDiffEditorModel([item])),
		}));
	},
	completeDeferredComparison(): void {
		completeDeferredComparison?.();
	},
	showFailedComparison(): void {
		const failedResources = resources.add(new DisposableStore());
		const item = failedResources.add(new DocumentDiffItem({ id: 'failed', label: 'failed.ts' }, async () => { throw new Error('Unavailable'); }));
		failedResources.add(editorServices.createInstance(MultiDiffEditorWidget, {
			container: document.getElementById('many')!,
			model: failedResources.add(new MultiDiffEditorModel([item])),
		}));
	},
	async showCompressedComparisons(count: number): Promise<void> {
		const compressedResources = resources.add(new DisposableStore());
		const lines = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n');
		const largeOriginal = compressedResources.add(new TextModel(lines));
		const largeModified = compressedResources.add(new TextModel(lines));
		const largeModel = compressedResources.add(new DiffModel({ original: largeOriginal, modified: largeModified, diffProvider: computation, diffOptions }));
		if (largeModel.state.kind !== 'ready') {
			await new Promise<void>((resolve, reject) => {
				const listener = largeModel.onDidChange(state => {
					if (state.kind === 'loading') return;
					listener.dispose();
					if (state.kind === 'error') reject(state.error);
					else resolve();
				});
			});
		}
		compressedEditor = compressedResources.add(editorServices.createInstance(MultiDiffEditorWidget, {
			container: document.getElementById('many')!,
			model: compressedResources.add(new MultiDiffEditorModel(Array.from({ length: count }, (_, index) =>
				compressedResources.add(new DocumentDiffItem({ id: `large-${index}`, label: `large-${index}.ts` }, largeModel))))),
		}));
	},
	get compressedLogicalScrollTop(): number {
		return compressedEditor?.saveViewState().scrollTop ?? 0;
	},
	saveCompressedPosition(): void {
		compressedViewState = compressedEditor!.saveViewState();
	},
	restoreCompressedPosition(): void {
		compressedEditor!.restoreViewState(compressedViewState);
	},
	get activeManyActions(): number {
		return activeManyActions;
	},
	setComparisonText(originalText: string, modifiedText: string): void {
		original.setValue(originalText);
		modified.setValue(modifiedText);
		input.value = modifiedText;
	},
	setHiddenRegions(enabled: boolean): void {
		single.setHideUnchangedRegionsOptions({ enabled, contextLineCount: 1, minimumLineCount: 3, revealLineCount: 2 });
	},
	removeSymbolProvider(): void {
		symbolProvider.dispose();
	},
	visibleDiffRanges(): { original: number[][]; modified: number[][] } {
		const lines = (ranges: readonly Range[]) => ranges.map(range => [range.startLineNumber, range.endLineNumber]);
		return { original: lines(single.originalEditor.getVisibleRanges()), modified: lines(single.modifiedEditor.getVisibleRanges()) };
	},
	setSecondComparisonText(originalText: string, modifiedText: string): void {
		secondOriginal.setValue(originalText);
		secondModified.setValue(modifiedText);
	},
	selectModifiedAll(): void {
		single.modifiedEditor.setSelection(Range.fromPositions(modified.positionAt(0), modified.positionAt(modified.getText().length)));
	},
	linePositions(originalLineNumber: number, modifiedLineNumber: number) {
		return {
			originalTop: single.originalEditor.getTopForLineNumber(originalLineNumber),
			modifiedTop: single.modifiedEditor.getTopForLineNumber(modifiedLineNumber),
			originalScrollTop: single.originalEditor.getScrollTop(),
			modifiedScrollTop: single.modifiedEditor.getScrollTop(),
		};
	},
	toggleWordWrap(): void {
		single.toggleWordWrap();
	},
	read() {
		return {
			state: model.state.kind,
			version: modified.version,
			resultVersion: model.state.modifiedVersion,
			kinds: model.diff?.rows.map(row => row.kind),
			quickDiffReady: reference.object.state.comparisons[0]?.model.state.kind === 'ready',
			quickDiffChanges: reference.object.state.changes.length,
			baselineRequests,
			activeRow: single.currentChangeRow,
			originalText: original.getText(),
			modifiedText: modified.getText(),
		};
	},
	async cancelLargeComparison() {
		const text = Array.from({ length: 20_000 }, (_, index) => String(index)).join('\n');
		using largeOriginal = new TextModel(text);
		using largeModified = new TextModel(text.split('\n').reverse().join('\n'));
		using cancellation = new CancellationTokenSource();
		const running = computation.computeDiff(largeOriginal, largeModified, diffOptions, cancellation.token);
		const outcome = running.then(() => 'completed', error => (error as Error).name);
		await new Promise(resolve => setTimeout(resolve, 50));
		cancellation.cancel();
		using nextOriginal = new TextModel('old');
		using nextModified = new TextModel('new');
		const next = await computation.computeDiff(nextOriginal, nextModified, diffOptions, CancellationToken.None);
		return { outcome: await outcome, kinds: toLineDiff(next, 1, 1).rows.map(row => row.kind) };
	},
	async compareLineEndings() {
		using original = new TextModel('first\r\nold\r\nlast');
		using modified = new TextModel('first\nnew\nlast');
		const result = await computation.computeDiff(original, modified, diffOptions, CancellationToken.None);
		return {
			identical: result.identical,
			changedLines: result.changes.map(change => [change.original.startLineNumber, change.modified.startLineNumber]),
			inlineColumns: result.changes[0]?.innerChanges?.map(change => [change.originalRange.startColumn, change.originalRange.endColumn]),
		};
	},
	async showTimedComparison(): Promise<boolean> {
		const timedResources = resources.add(new DisposableStore());
		const text = Array.from({ length: 20_000 }, (_, index) => String(index)).join('\n');
		const timedOriginal = timedResources.add(new TextModel(text));
		const timedModified = timedResources.add(new TextModel(text.split('\n').reverse().join('\n')));
		const timedModel = timedResources.add(new DiffModel({
			original: timedOriginal,
			modified: timedModified,
			diffProvider: computation,
			diffOptions: { ...diffOptions, maxComputationTimeMs: 1 },
		}));
		timedResources.add(editorServices.createInstance(DiffEditorWidget, { container: document.getElementById('timed-single')!, model: timedModel }));
		timedResources.add(editorServices.createInstance(MultiDiffEditorWidget, {
			container: document.getElementById('timed-multi')!,
			model: timedResources.add(new MultiDiffEditorModel([timedResources.add(new DocumentDiffItem({ id: 'timed', label: 'timed.ts' }, timedModel))])),
		}));
		if (timedModel.state.kind !== 'ready') {
			await new Promise<void>((resolve, reject) => {
				const listener = timedModel.onDidChange(state => {
					if (state.kind === 'loading') return;
					listener.dispose();
					if (state.kind === 'error') reject(state.error);
					else resolve();
				});
			});
		}
		return timedModel.state.kind === 'ready' && timedModel.state.quitEarly;
	},
	setChineseLocale(): void {
		const catalog = builtinLanguagePackCatalogs.find(candidate => candidate.locale === 'zh-CN')!;
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
	},
	async setQuickDiffWhitespace(setting: 'false' | 'inherit'): Promise<void> {
		await configuration.updateValue(ScmConfiguration.diffDecorationsIgnoreTrimWhitespace, setting);
	},
	async setDiffWhitespace(ignore: boolean): Promise<void> {
		await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, ignore);
	},
	async setDiffWhitespaceForLanguage(languageId: string, ignore: boolean): Promise<void> {
		await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, ignore, { overrideIdentifier: languageId });
	},
	setModifiedLanguage(languageId: string): void {
		modified.setLanguage(languageId);
	},
	dispose(): void {
		resources.dispose();
	},
};

declare global {
	interface Window {
		ashDiffIntegration: typeof harness;
	}
}
window.ashDiffIntegration = harness;
