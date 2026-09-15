import { registerEditorContribution } from '../../../browser/editorExtensions.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { type View } from '../../../browser/view.js';
import { StableEditorScrollState } from '../../../browser/stableEditorScroll.js';
import { TimeoutTimer } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { type URI } from '../../../../base/common/uri.js';
import { type LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import { type CodeLens, type CodeLensProvider, type Command } from '../../../common/languages.js';
import { codeLensCache } from './codeLensCache.js';
import { CodeLensModel, getCodeLensModel, type CodeLensItem } from './codelens.js';
import { CodeLensWidget } from './codelensWidget.js';

export type ExecuteCodeLensCommand = (id: string, args: readonly unknown[] | undefined) => void | Promise<void>;

/** Coordinates provider requests, visible deferred resolves, and line-owned CodeLens widgets. */
export class CodeLensContribution extends Disposable {
	public static readonly ID = 'css.editor.codeLens';

	private readonly widgets = this._register(new DisposableMap<number, CodeLensWidget>());
	private readonly providerListeners = this._register(new DisposableStore());
	private readonly cacheExpiry = this._register(new TimeoutTimer());
	private readonly resolvingWidgets = new Map<CodeLensWidget, CancellationTokenSource>();
	private request: CancellationTokenSource | undefined;
	private currentModel = CodeLensModel.Empty;
	private cachedModel: CodeLensModel | undefined;
	private refreshPromise: Promise<void> | undefined;
	private resolvePromise: Promise<void> | undefined;
	private refreshScheduled = false;
	public constructor(
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly providers: LanguageFeatureRegistry<CodeLensProvider>,
		private readonly resource: URI | undefined,
		private readonly onExecuteCommand: ExecuteCodeLensCommand | undefined,
		private readonly onError: (error: unknown) => void = error => console.error('Stanza CodeLens failed', error),
	) {
		super();
		this.bindProviderListeners();
		this._register(providers.onDidChange(() => {
			this.bindProviderListeners();
			this.scheduleRefresh();
		}));
		this._register(viewport.textModel.onDidChangeContent(() => {
			this.setModel(CodeLensModel.Empty);
			this.clearWidgets();
			this.scheduleRefresh();
		}));
		this._register(viewport.onDidChangeLayout(() => this.layoutAndResolve()));
		const cachedModel = resource ? codeLensCache.get(resource, viewport.textModel.lineCount) : undefined;
		if (cachedModel) {
			this.cachedModel = cachedModel;
			this.setModel(cachedModel);
			this.reconcileWidgets(cachedModel.lenses);
		}
		this.refreshPromise = this.refresh();
	}

	public override dispose(): void {
		if (this.isDisposed) return;
		this.request?.dispose(true);
		this.request = undefined;
		this.refreshPromise = undefined;
		this.resolvePromise = undefined;
		this.refreshScheduled = false;
		this.resolvingWidgets.clear();
		this.cachedModel = undefined;
		const model = this.currentModel;
		this.currentModel = CodeLensModel.Empty;
		if (model !== CodeLensModel.Empty) model.dispose();
		super.dispose();
	}

	public async getModel(): Promise<CodeLensModel> {
		await this.refreshPromise;
		while (this.resolvePromise) await this.resolvePromise;
		return this.currentModel;
	}

	private bindProviderListeners(): void {
		this.providerListeners.clear();
		for (const provider of this.providers.ordered(this.viewport.textModel)) {
			if (provider.onDidChange) this.providerListeners.add(provider.onDidChange(() => this.scheduleRefresh()));
		}
	}

	private scheduleRefresh(): void {
		if (this.refreshScheduled || this.isDisposed) return;
		this.refreshScheduled = true;
		queueMicrotask(() => {
			this.refreshScheduled = false;
			if (!this.isDisposed) this.refreshPromise = this.refresh();
		});
	}

	private async refresh(): Promise<void> {
		this.request?.dispose(true);
		this.resolvePromise = undefined;
		this.resolvingWidgets.clear();
		this.cacheExpiry.cancel();
		if (!this.providers.has(this.viewport.textModel)) {
			this.showCachedModelUntilExpiry();
			return;
		}
		const request = this.request = new CancellationTokenSource();
		const model = await getCodeLensModel(this.providers, this.viewport.textModel, request.token);
		if (request.token.isCancellationRequested || request !== this.request) {
			if (model !== CodeLensModel.Empty) model.dispose();
			return;
		}
		this.cachedModel = undefined;
		this.setModel(model);
		this.updateCache();
		this.reconcileWidgets(model.lenses);
		this.layoutAndResolve();
	}

	private showCachedModelUntilExpiry(): void {
		const cachedModel = this.resource ? codeLensCache.get(this.resource, this.viewport.textModel.lineCount) : undefined;
		if (!cachedModel) {
			this.cachedModel = undefined;
			this.setModel(CodeLensModel.Empty);
			this.clearWidgets();
			return;
		}
		this.cachedModel = cachedModel;
		this.setModel(cachedModel);
		this.reconcileWidgets(cachedModel.lenses);
		this.cacheExpiry.cancelAndSet(() => {
			if (this.cachedModel !== cachedModel || this.isDisposed) return;
			if (this.resource) codeLensCache.delete(this.resource);
			this.cachedModel = undefined;
			this.setModel(CodeLensModel.Empty);
			this.clearWidgets();
		}, 30_000);
	}

	private reconcileWidgets(items: readonly CodeLensItem[]): void {
		const scrollState = StableEditorScrollState.capture(this.editor);
		const groups = groupCodeLensItems(items);
		const currentWidgets = new Map(this.widgets);
		try {
			for (const lineNumber of [...this.widgets.keys()]) {
				if (!groups.has(lineNumber)) this.widgets.deleteAndDispose(lineNumber);
			}
			for (const [lineNumber, lineItems] of groups) {
				const current = currentWidgets.get(lineNumber);
				if (current) {
					current.updateCodeLensItems(lineItems);
					continue;
				}
				this.widgets.set(lineNumber, new CodeLensWidget(this.viewport, lineItems, this.onExecuteCommand ? command => this.executeCommand(command) : undefined));
			}
		} finally {
			scrollState.restore(this.editor);
		}
	}

	private clearWidgets(): void {
		const scrollState = StableEditorScrollState.capture(this.editor);
		try {
			for (const lineNumber of [...this.widgets.keys()]) this.widgets.deleteAndDispose(lineNumber);
		} finally {
			scrollState.restore(this.editor);
		}
	}

	private layoutAndResolve(): void {
		for (const [, widget] of this.widgets) widget.layout();
		const request = this.request;
		if (!request || request.token.isCancellationRequested) return;
		const visible = [...this.widgets].map(([, widget]) => widget).filter(widget => widget.isVisible() && widget.needsResolve && !this.resolvingWidgets.has(widget));
		if (visible.length === 0) return;
		const batchPromise = Promise.all(visible.map(widget => this.resolveWidget(widget, request))).then(
			() => undefined,
			error => { if (!request.token.isCancellationRequested) this.onError(error); },
		);
		const previousPromise = this.resolvePromise;
		const resolvePromise = previousPromise
			? Promise.all([previousPromise, batchPromise]).then(() => undefined)
			: batchPromise;
		this.resolvePromise = resolvePromise;
		void resolvePromise.finally(() => {
			if (this.resolvePromise === resolvePromise) this.resolvePromise = undefined;
		});
	}

	private async resolveWidget(widget: CodeLensWidget, request: CancellationTokenSource): Promise<void> {
		this.resolvingWidgets.set(widget, request);
		const items = widget.codeLensItems;
		try {
			const symbols = await Promise.all(items.map(item => this.resolveItem(item, request)));
			if (request.token.isCancellationRequested || request !== this.request || widget.codeLensItems !== items || widget.isDisposed) return;
			const resolvedItems = items.map((item, index) => symbols[index] ? Object.freeze({ symbol: symbols[index]!, provider: item.provider }) : item);
			this.replaceResolvedItems(items, resolvedItems);
			widget.updateResolvedCodeLensItems(resolvedItems);
			this.updateCache();
		} finally {
			if (this.resolvingWidgets.get(widget) === request) this.resolvingWidgets.delete(widget);
		}
	}

	private replaceResolvedItems(previousItems: readonly CodeLensItem[], resolvedItems: readonly CodeLensItem[]): void {
		const replacements = new Map(previousItems.map((item, index) => [item, resolvedItems[index]!] as const));
		this.currentModel.lenses = this.currentModel.lenses.map(item => replacements.get(item) ?? item);
	}

	private async resolveItem(item: CodeLensItem, request: CancellationTokenSource): Promise<CodeLens | undefined> {
		if (item.symbol.command || !item.provider.resolveCodeLens) return item.symbol;
		try {
			return await Promise.resolve(item.provider.resolveCodeLens(this.viewport.textModel, item.symbol, request.token)) ?? undefined;
		} catch (error) {
			if (!request.token.isCancellationRequested) this.onError(error);
			return undefined;
		}
	}

	private setModel(model: CodeLensModel): void {
		if (this.currentModel !== model && this.currentModel !== CodeLensModel.Empty) this.currentModel.dispose();
		this.currentModel = model;
	}

	private updateCache(): void {
		if (this.resource) codeLensCache.put(this.resource, this.viewport.textModel.lineCount, this.currentModel);
	}

	private executeCommand(command: Command): void {
		try {
			const result = this.onExecuteCommand!(command.id, command.arguments);
			if (result && typeof (result as { readonly then?: unknown }).then === 'function') {
				void Promise.resolve(result as PromiseLike<void>).catch(this.onError);
			}
		} catch (error) {
			this.onError(error);
		}
	}
}

function groupCodeLensItems(items: readonly CodeLensItem[]): ReadonlyMap<number, readonly CodeLensItem[]> {
	const groups = new Map<number, CodeLensItem[]>();
	for (const item of items) {
		const lineNumber = item.symbol.range.startLineNumber;
		const group = groups.get(lineNumber);
		if (group) group.push(item);
		else groups.set(lineNumber, [item]);
	}
	return groups;
}

registerEditorContribution({
	id: CodeLensContribution.ID,
	install: context => {
		if (context.kind !== 'text' || context.options.codeLens === false || context.model.largeFile.tooLargeForTokenization) return;
		return new CodeLensContribution(
			context.editor,
			context.view,
			context.languageFeaturesService.codeLensProvider,
			context.options.input.resource,
			context.options.onExecuteEditorCommand,
			context.onLanguageError,
		);
	},
});
