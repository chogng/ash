import { onUnexpectedError } from '../../../../base/common/errors.js';
import { h } from '../../../../base/browser/dom.js';
import { getHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { type ObjectTreeElement } from '../../../../base/browser/ui/tree/objectTreeModel.js';
import { DisposableMap, DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Range } from '../../../../editor/common/core/range.js';
import { localize } from '../../../../nls.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { type ITestCase, type ITestCaseResult, type ITestProfile, type ITestRun, ITestingService } from '../../../services/testing/common/testingService.js';
import { ITerminalService } from '../../../services/terminal/common/terminal.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { TERMINAL_VIEW_ID } from '../../terminal/common/terminal.js';
import { testStateLabel } from './testingLabels.js';

interface TestTreeItem {
	readonly id: string;
	readonly label: string;
	readonly keys: readonly string[];
	readonly test?: ITestCase;
}

/** Workspace cases and their results; script commands remain a separate task section. */
export class TestingViewPane extends ViewPane {
	private readonly tree: WorkbenchObjectTree<TestTreeItem>;
	private readonly statusDomNode: HTMLElement;
	private readonly outputDomNode: HTMLPreElement;
	private readonly resultLabelDomNode: HTMLElement;
	private readonly scriptsDomNode: HTMLElement;
	private readonly rowHovers = this._register(new DisposableMap<HTMLElement, IDisposable>());
	private readonly scriptDisposables = this._register(new DisposableStore());
	private readonly runAllButton: Button;
	private readonly runSelectedButton: Button;
	private readonly debugButton: Button;
	private readonly failedButton: Button;
	private readonly refreshButton: Button;
	private readonly cancelButton: Button;
	private readonly failureButton: Button;
	private selected: readonly TestTreeItem[] = [];
	private renderedTests: readonly ITestCase[] | undefined;
	private renderedProfiles: readonly ITestProfile[] | undefined;
	private renderedRuns: readonly ITestRun[] | undefined;
	private error: string | undefined;
	private resultsByKey = new Map<string, ITestCaseResult>();

	constructor(container: HTMLElement, options: IViewPaneOptions,
		@ITestingService private readonly testing: ITestingService,
		@ITerminalService private readonly terminal: ITerminalService,
		@IViewsService private readonly views: IViewsService,
		@IEditorService private readonly editors: IEditorService,
		@IConfigurationService configuration: IConfigurationService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super(container, options);
		const document = container.ownerDocument;
		this.contentElement.classList.add('ash-testing');
		const controls = h(document, 'div');
		controls.className = 'ash-testing-controls';
		this.runAllButton = this.makeButton(controls, localize('testing.runAll', 'Run All Tests'), () => testing.runTests(testing.tests.map(test => test.key)));
		this.runSelectedButton = this.makeButton(controls, localize('testing.runSelected', 'Run Selected'), () => testing.runTests([...new Set(this.selected.flatMap(item => item.keys))]));
		this.debugButton = this.makeButton(controls, localize('testing.debugSelected', 'Debug Selected Test'), () => testing.debugTest(this.selected[0]!.test!.key));
		this.failedButton = this.makeButton(controls, localize('testing.rerunFailed', 'Rerun Failed'), () => testing.rerunFailedTests());
		this.refreshButton = this.makeButton(controls, localize('testing.refresh', 'Refresh Tests'), () => testing.refresh());
		this.cancelButton = this.makeButton(controls, localize('testing.cancel', 'Cancel Tests'), () => testing.cancelTests());
		this.statusDomNode = h(document, 'div');
		this.statusDomNode.className = 'ash-testing-status';
		this.statusDomNode.setAttribute('role', 'status');
		this.statusDomNode.setAttribute('aria-live', 'polite');
		const treeContainer = h(document, 'div');
		treeContainer.className = 'ash-testing-tree';
		this.tree = this._register(new WorkbenchObjectTree<TestTreeItem>(treeContainer, {
			configurationService: configuration,
			ariaLabel: localize('testing.tree', 'Tests'),
			scrolling: 'managed',
			getHeight: () => 22,
			modelOptions: { identityProvider: { getId: item => item.id }, defaultCollapseState: 'expanded' },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: item => item.label },
			expandOnDoubleClick: false,
			reuseRows: true,
			onDidRemoveRow: row => {
				const content = row.querySelector<HTMLElement>('.ash-testing-row');
				if (content) { this.rowHovers.deleteAndDispose(content); }
			},
			renderElement: item => this.renderRow(item),
		}));
		this.tree.element.setAttribute('aria-description', localize('testing.treeHelp', 'Use arrow keys to navigate tests. Press Enter to open a test. Select a package, file, or test, then choose Run Selected.'));
		const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Testing);
		if (hint) { this.tree.element.setAttribute('aria-description', this.tree.element.getAttribute('aria-description') + ' ' + hint); }
		this._register(this.tree.onDidChangeSelection(event => { this.selected = event.elements; this.render(); }));
		this._register(this.tree.onDidOpen(event => {
			const test = event.element.test;
			if (test?.resource && test.source) {
				this.invoke(() => this.editors.openEditor({ resource: test.resource! }, { ...event.editorOptions, selection: new Range(test.source!.line, 1, test.source!.line, 1) }, event.sideBySide ? 'sideGroup' : 'activeGroup'));
			} else if (event.browserEvent instanceof KeyboardEvent && (event.browserEvent.key === 'Enter' || event.browserEvent.key === ' ')) { this.tree.toggleCollapsed(event.element.id); }
		}));
		const result = h(document, 'section');
		result.className = 'ash-testing-output';
		result.setAttribute('aria-label', localize('testing.result', 'Test result'));
		this.resultLabelDomNode = h(document, 'div');
		this.resultLabelDomNode.className = 'ash-testing-result-label';
		this.failureButton = this.makeButton(result, localize('testing.openFailure', 'Open Failure Location'), () => this.openSelectedFailure());
		this.outputDomNode = h(document, 'pre');
		this.outputDomNode.tabIndex = 0;
		this.outputDomNode.setAttribute('aria-label', localize('testing.output', 'Test output'));
		result.prepend(this.resultLabelDomNode);
		result.append(this.outputDomNode);
		const details = h(document, 'details');
		const summary = h(document, 'summary');
		summary.textContent = localize('testing.scripts', 'Test Scripts');
		details.append(summary);
		this.scriptsDomNode = h(document, 'div');
		this.scriptsDomNode.className = 'ash-testing-scripts';
		details.append(this.scriptsDomNode);
		this.contentElement.append(controls, this.statusDomNode, treeContainer, result, details);
		this._register(testing.onDidChangeTests(() => this.render()));
		this._register(testing.onDidChangeProfiles(() => this.renderScripts()));
		this._register(testing.onDidStartRun(() => this.renderScripts()));
		this._register(testing.onDidChangeRun(() => this.renderScripts(true)));
		this.render();
		this.renderScripts();
		this.invoke(() => testing.refresh());
	}

	private makeButton(container: HTMLElement, label: string, action: () => Promise<unknown>): Button {
		return this._register(new Button(container, { label, size: 'small', onClick: () => this.invoke(action) }));
	}

	private invoke(action: () => Promise<unknown>): void {
		this.error = undefined;
		void action().catch(error => {
			this.error = error instanceof Error ? error.message : localize('testing.operationFailed', 'Test operation failed.');
		}).finally(() => { if (!this.isDisposed) { this.render(); } });
	}

	private render(): void {
		const results = this.testing.testResults;
		this.resultsByKey = new Map(results.map(result => [result.key, result]));
		const busy = this.testing.isDiscovering || this.testing.isRunningTests;
		this.runAllButton.enabled = !busy && this.testing.tests.length > 0;
		this.runSelectedButton.enabled = !busy && this.selected.length > 0;
		this.debugButton.enabled = !busy && this.selected.length === 1 && this.selected[0]?.test?.debuggable === true;
		this.failedButton.enabled = !busy && results.some(result => result.state === 'failed' || result.state === 'errored');
		this.refreshButton.enabled = !busy;
		this.cancelButton.enabled = busy;
		this.statusDomNode.textContent = this.error ?? (this.testing.isDiscovering ? localize('testing.discovering', 'Building and discovering tests…') : this.testing.isDebuggingTest ? localize('testing.debugging', 'Debugging test…') : this.testing.isRunningTests ? localize('testing.running', 'Running tests…') : this.testing.tests.length === 0 ? localize('testing.empty', 'No Rust tests found. Test scripts are listed below.') : localize('testing.summary', '{0} tests · {1} passed · {2} failed · {3} skipped', this.testing.tests.length, results.filter(result => result.state === 'passed').length, results.filter(result => result.state === 'failed' || result.state === 'errored').length, results.filter(result => result.state === 'skipped').length));
		if (this.renderedTests !== this.testing.tests) {
			this.renderedTests = this.testing.tests;
			this.tree.setChildren(this.buildTree());
			this.selected = this.selected.flatMap(item => { const current = this.tree.model.getElement(item.id); return current ? [current] : []; });
		}
		for (const status of this.tree.element.querySelectorAll<HTMLElement>('[data-test-key]')) {
			const result = this.resultsByKey.get(status.dataset.testKey!);
			status.className = `ash-testing-case-state ${result?.state ?? 'unset'}`;
			status.textContent = testStateLabel(result?.state);
		}
		const test = this.selected.length === 1 ? this.selected[0]?.test : undefined;
		const result = test ? this.resultsByKey.get(test.key) : undefined;
		this.resultLabelDomNode.textContent = test ? `${test.name} — ${testStateLabel(result?.state)}${result ? ` · ${result.durationMs} ms` : ''}` : localize('testing.selectResult', 'Select a test to read its result.');
		this.outputDomNode.textContent = result ? result.output + (result.outputTruncated ? '\n' + localize('testing.outputTruncated', 'Output exceeded the capture limit.') : '') : '';
		this.failureButton.hidden = !result?.failurePath || !result.failureLine;
	}

	private buildTree(): readonly ObjectTreeElement<TestTreeItem>[] {
		const packages = new Map<string, Map<string, ITestCase[]>>();
		for (const test of this.testing.tests) {
			const id = `${test.dirId}:${test.package}:${test.targetKind}:${test.target}`;
			let files = packages.get(id);
			if (!files) { files = new Map(); packages.set(id, files); }
			const path = test.source?.path ?? '';
			const tests = files.get(path) ?? [];
			tests.push(test); files.set(path, tests);
		}
		return [...packages].map(([id, files]) => {
			const tests = [...files.values()].flat();
			const first = tests[0]!;
			const folder = this.workspace.getWorkspace().folders.find(folder => folder.id === first.dirId)!;
			const target = first.targetKind === 'documentation' ? localize('testing.documentationTarget', '{0} · Documentation Tests', first.target) : first.target;
			return { element: { id, label: `${folder.name} / ${first.package} / ${target}`, keys: tests.map(test => test.key) }, children: [...files].map(([path, cases]) => ({
				element: { id: id + ':' + path, label: path || localize('testing.noSource', 'Tests without a source location'), keys: cases.map(test => test.key) },
				children: cases.map(test => ({ element: { id: test.key, label: test.name, keys: [test.key], test } })),
			})) };
		});
	}

	private renderRow(item: TestTreeItem): HTMLElement {
		const row = h(this.element.ownerDocument, 'span');
		row.className = 'ash-testing-row';
		this.rowHovers.set(row, getHoverDelegate().setupHover({ target: row, content: item.label }));
		const state = item.test ? this.resultsByKey.get(item.test.key)?.state : undefined;
		const label = h(this.element.ownerDocument, 'span');
		label.textContent = item.label;
		row.append(label);
		if (item.test) {
			const status = h(this.element.ownerDocument, 'span');
			status.dataset.testKey = item.test.key;
			status.className = `ash-testing-case-state ${state ?? 'unset'}`;
			status.textContent = testStateLabel(state);
			row.append(status);
		}
		return row;
	}

	private renderScripts(force = false): void {
		if (!force && this.renderedProfiles === this.testing.profiles && this.renderedRuns === this.testing.runs) { return; }
		this.renderedProfiles = this.testing.profiles; this.renderedRuns = this.testing.runs;
		this.scriptDisposables.clear();
		this.scriptsDomNode.replaceChildren();
		for (const profile of this.testing.profiles) {
			const row = h(this.element.ownerDocument, 'div');
			row.className = 'ash-testing-script';
			this.scriptDisposables.add(new Button(row, { label: localize('testing.runScript', 'Run Script'), size: 'small', title: profile.detail, onClick: () => this.invoke(() => this.testing.run(profile)) }));
			const label = h(this.element.ownerDocument, 'span');
			label.textContent = profile.label;
			row.append(label); this.scriptsDomNode.append(row);
		}
		for (const run of this.testing.runs.slice(-10).reverse()) {
			this.scriptDisposables.add(new Button(this.scriptsDomNode, { label: `${run.profile.label} — ${run.status === 'completed' ? localize('testing.scriptCompleted', 'Completed') : testStateLabel(run.status === 'canceled' ? 'cancelled' : run.status)}`, size: 'small', onClick: () => { this.terminal.setActiveInstance(run.taskRun.terminal); void this.views.focusView(TERMINAL_VIEW_ID).catch(onUnexpectedError); } }));
		}
	}

	private openSelectedFailure(): Promise<void> {
		const test = this.selected[0]?.test;
		const result = test ? this.resultsByKey.get(test.key) : undefined;
		if (!test || !result?.failurePath || !result.failureLine) { return Promise.resolve(); }
		const folder = this.workspace.getWorkspace().folders.find(folder => folder.id === test.dirId)!;
		const failure = result.failurePath;
		const absolute = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(failure);
		const path = absolute ? URI.file(failure).path : folder.uri.path.replace(/\/$/, '') + '/' + failure.replaceAll('\\', '/');
		return this.editors.openEditor({ resource: URI.from({ scheme: folder.uri.scheme, authority: folder.uri.authority, path }) }, { selection: new Range(result.failureLine, 1, result.failureLine, 1) });
	}

	getAccessibleContent(): string {
		return [this.statusDomNode.textContent, ...this.testing.tests.map(test => `${test.name}: ${testStateLabel(this.resultsByKey.get(test.key)?.state)}`), this.resultLabelDomNode.textContent, this.outputDomNode.textContent].join('\n');
	}
}
