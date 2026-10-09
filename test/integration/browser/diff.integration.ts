import type { ITextResourceStore } from '../../../src/ash/workbench/services/textmodelResolver/common/textResourceStore.js';
import { TestUriIdentityServices } from '../../../src/ash/platform/uriIdentity/test/common/uriIdentityTestServices.js';
import '../../../src/ash/workbench/contrib/scm/browser/quickDiff.contribution.js';
import { addDisposableListener } from '../../../src/ash/base/browser/dom.js';
import { CancellationToken, CancellationTokenSource } from '../../../src/ash/base/common/cancellation.js';
import { DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
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
import { QuickDiffService } from '../../../src/ash/workbench/contrib/scm/common/quickDiffService.js';
import { CodeEditorConfiguration } from '../../../src/ash/workbench/contrib/codeEditor/common/editorConfiguration.js';
import { resetNlsResolver, setNlsMessages } from '../../../src/ash/nls.js';
import { builtinLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { Registry } from '../../../src/ash/platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../src/ash/platform/configuration/common/configurationRegistry.js';
import { CommandsRegistry } from '../../../src/ash/platform/commands/common/commands.js';
import { MenusRegistry, MenuId } from '../../../src/ash/platform/actions/common/actions.js';
import type { DiffEditorSelectionHunkToolbarContext } from '../../../src/ash/editor/browser/widget/diffEditor/features/gutterFeature.js';
import type { IDiffEditorOptions } from '../../../src/ash/editor/common/config/editorOptions.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { BrowserTextModelService } from '../../../src/ash/workbench/services/textmodelResolver/browser/browserTextModelService.js';
import { EditorPanes } from '../../../src/ash/workbench/browser/editor.js';
import { isEditorPaneWithViewState } from '../../../src/ash/workbench/browser/parts/editor/editorWithViewState.js';
import { MultiDiffEditor } from '../../../src/ash/workbench/contrib/multiDiffEditor/browser/multiDiffEditor.js';
import { matchMultiDiffEditor } from '../../../src/ash/workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { IChatService, type TurnChangeSetSummary } from '../../../src/ash/workbench/services/chat/common/chatService.js';
import { ISessionsManagementService } from '../../../src/ash/sessions/services/sessions/common/sessionsManagement.js';
import { SessionChangesEditor } from '../../../src/ash/sessions/contrib/changes/browser/sessionChangesEditor.js';

// Display language is fixed before constructing widgets, as it is at product startup.
if (new URLSearchParams(location.search).get('locale') === 'zh-CN') {
	const catalog = builtinLanguagePackCatalogs.find(candidate => candidate.locale === 'zh-CN')!;
	setNlsMessages(catalog.locale, catalog.bundles);
}

const resources = new DisposableStore();
const uriIdentityServices = resources.add(new TestUriIdentityServices());
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
const multi = resources.add(editorServices.createInstance(MultiDiffEditorWidget, {
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
const baselines = resources.add(new QuickDiffService());
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
let lastHunkAction: { text: string; originalStart: number; modifiedStart: number; } | undefined;
let themeBinding: IDisposable | undefined;
const sessionPane = resources.add(new MutableDisposable<SessionChangesEditor>());
const sessionChanges = resources.add(new Emitter<{ sessionId: string; threadId: string; }>());
let sessionServices: ReturnType<typeof editorServices.createChild> | undefined;

function createSessionChangesPane(): SessionChangesEditor {
	if (!sessionServices) {
		sessionServices = resources.add(editorServices.createChild());
		sessionServices.registerInstance(IThemeService, editorServices.themeService);
		sessionServices.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'diff-integration', flushInterval: 0 })));
		sessionServices.registerInstance(IDialogService, { confirm: async () => ({ confirmed: false }) } as unknown as IDialogService);
		sessionServices.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
		sessionServices.registerInstance(ISessionsManagementService, { sessions: [{ sessionId: 'review' }, { sessionId: 'other' }] } as unknown as ISessionsManagementService);
		const summary: TurnChangeSetSummary = {
			changeSetId: 'review-change', sessionId: 'review', threadId: 'review-thread', turnId: 'review-turn', repositoryId: 'review-repository',
			captureState: 'sealed', messageState: 'unconfigured', commitState: 'idle', committedPaths: [], revision: 1,
			statistics: { files: 8, additions: 8, deletions: 8 }, dependencies: [], externalDependencyPaths: [], warnings: [], conflictPaths: [],
		};
		sessionServices.registerInstance(IChatService, {
			onDidUpdateTurnChanges: sessionChanges.event,
			onDidBecomeReady: Event.None,
			listTurnChanges: async () => [summary],
			readTurnChange: async () => ({ summary, files: Array.from({ length: 8 }, (_, index) => ({ path: `file-${index}.ts`, kind: 'modified', binary: false, additions: 1, deletions: 1 })) }),
			readTurnChangeFile: async (_sessionId: string, _threadId: string, _changeSetId: string, path: string) => ({ path, binary: false, truncated: false, before: `before\n${'shared\n'.repeat(30)}`, after: `after\n${'shared\n'.repeat(30)}` }),
		} as unknown as IChatService);
		const models = resources.add(uriIdentityServices.createInstance(BrowserTextModelService, {
			onDidChange: Event.None,
			resolve: async request => ({ resource: request.resource, text: request.bootstrapText ?? '', revision: undefined }),
			save: async () => { throw new Error('Session review is read-only'); },
		} satisfies ITextResourceStore, {}));
		resources.add(EditorPanes.registerEditorPane({
			id: 'integration.sessionMultiDiff', name: 'Session review', canOpen: matchMultiDiffEditor,
			create: () => sessionServices!.createInstance(MultiDiffEditor, { modelService: models, createComputationService: () => service.createComputationService(), lineHeight: 0 }),
		}));
	}
	const pane = sessionServices.createInstance(SessionChangesEditor, {});
	sessionPane.value = pane;
	pane.create(document.getElementById('session-changes')!);
	pane.layout({ width: 800, height: 240 });
	return pane;
}

const harness = {
	async openSessionChanges(): Promise<void> {
		const pane = createSessionChangesPane();
		pane.setVisible(true);
		await pane.setInput({ resource: URI.parse('ash-session-changes:/review?thread=review-thread') }, new AbortController().signal);
	},
	setSessionChangesVisible(visible: boolean): void { sessionPane.value!.setVisible(visible); },
	refreshSessionChanges(): void { sessionChanges.fire({ sessionId: 'review', threadId: 'review-thread' }); },
	readSessionViewState(): unknown {
		const pane = sessionPane.value!;
		return isEditorPaneWithViewState(pane) ? pane.saveViewState() : null;
	},
	async reopenSessionChanges(): Promise<void> {
		const state = this.readSessionViewState();
		sessionPane.clear();
		const pane = createSessionChangesPane();
		await pane.setInput({ resource: URI.parse('ash-session-changes:/review?thread=review-thread') }, new AbortController().signal);
		if (isEditorPaneWithViewState(pane)) pane.restoreViewState(state);
		pane.setVisible(true);
	},
	async switchSessionChanges(): Promise<void> {
		await sessionPane.value!.setInput({ resource: URI.parse('ash-session-changes:/other?thread=other-thread') }, new AbortController().signal);
	},
	activeMultiControl(): string | undefined {
		return multi.getActiveControl()?.modifiedEditor.getModel()?.getText();
	},
	focusMulti(): void { multi.focus(); },
	readIndicatorSetting(): { title: string; description: string; } {
		const setting = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration('diffEditor.renderIndicators')!.setting!;
		return { title: setting.title, description: setting.description };
	},
	setTheme(themeId: string): { marker: string; background: string; } {
		themeBinding ??= resources.add(bindColorTheme(editorServices.themeService, document.getElementById('single')!));
		editorServices.themeService.setTheme(themeId);
		const theme = editorServices.themeService.getColorTheme();
		const cssColor = (id: string) => {
			const { r, g, b } = theme.getColor(id)!.rgba;
			return `rgb(${r}, ${g}, ${b})`;
		};
		return { marker: cssColor('diffEditor.removedLineMarker'), background: cssColor('diffEditorGutter.removedLineBackground') };
	},
	async setDiffIndicators(enabled: boolean): Promise<void> {
		await editorServices.get(IConfigurationService).updateValue('diffEditor.renderIndicators', enabled);
	},
	setEditorFeatures(options: IDiffEditorOptions): void {
		single.updateOptions(options);
	},
	setFontOptions(options: Pick<IDiffEditorOptions, 'fontFamily' | 'fontSize' | 'lineHeight' | 'fontLigatures'>): void {
		single.originalEditor.updateOptions(options);
		single.modifiedEditor.updateOptions(options);
	},
	async setMoves(enabled: boolean): Promise<void> {
		await editorServices.get(IConfigurationService).updateValue('diffEditor.experimental.showMoves', enabled);
		model.updateOptions({ ...diffOptions, computeMoves: enabled });
	},
	registerHunkAction(selection = false): void {
		const command = selection ? 'integration.selectionAction' : 'integration.hunkAction';
		resources.add(CommandsRegistry.register(command, (_accessor, ...args) => {
			const context = args[0] as DiffEditorSelectionHunkToolbarContext;
			lastHunkAction = { text: context.originalWithModifiedChanges, originalStart: context.mapping.original.startLineNumber, modifiedStart: context.mapping.modified.startLineNumber };
		}));
		resources.add(MenusRegistry.appendMenuItem(selection ? MenuId.DiffEditorSelectionToolbar : MenuId.DiffEditorHunkToolbar, {
			command: { id: command, title: selection ? 'Apply selected change' : 'Apply change' }, group: 'primary',
		}));
	},
	get lastHunkAction() { return lastHunkAction; },
	selectModified(range: [number, number, number, number]): void {
		single.modifiedEditor.setSelection(new Range(...range));
	},
	editModified(range: [number, number, number, number], text: string): void {
		single.modifiedEditor.pushUndoStop();
		single.modifiedEditor.executeEdits('integration', [{ range: new Range(...range), text }]);
		single.modifiedEditor.pushUndoStop();
	},
	exitCompareMove(): void {
		single.exitCompareMove();
	},
	undo(): void { modified.undo(); },
	scrollModified(top: number): void { single.modifiedEditor.setScrollTop(top); },
	setViewMode(renderSideBySide: boolean, useInlineViewWhenSpaceIsLimited: boolean, inlineBreakpoint: number): void {
		single.setViewMode(renderSideBySide, useInlineViewWhenSpaceIsLimited, inlineBreakpoint);
	},
	showManyComparisons(count: number): void {
		const manyResources = resources.add(new DisposableStore());
		manyResources.add(editorServices.createInstance(MultiDiffEditorWidget, {
			container: document.getElementById('many')!,
			model: manyResources.add(new MultiDiffEditorModel(Array.from({ length: count }, (_, index) => manyResources.add(new DocumentDiffItem({ id: `file-${index}`, label: `file-${index}.ts` }, model))))),
			workbenchUIElementFactory: {
				createItemActions: () => {
					activeManyActions++;
					return toDisposable(() => activeManyActions--);
				}
			},
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
	visibleDiffRanges(): { original: number[][]; modified: number[][]; } {
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
			originalBottom: single.originalEditor.getBottomForLineNumber(originalLineNumber),
			modifiedBottom: single.modifiedEditor.getBottomForLineNumber(modifiedLineNumber),
			originalContentHeight: single.originalEditor.getContentHeight(),
			modifiedContentHeight: single.modifiedEditor.getContentHeight(),
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
			moves: model.diff?.moves.length,
			accessibleContent: single.getAccessibleContent(),
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
	async setQuickDiffWhitespace(setting: 'false' | 'inherit'): Promise<void> {
		await configuration.updateValue('scm.diffDecorationsIgnoreTrimWhitespace', setting);
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
