import { addDisposableListener } from '../../../src/ash/base/browser/dom.js';
import { CancellationToken, CancellationTokenSource } from '../../../src/ash/base/common/cancellation.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { DiffEditorWidget } from '../../../src/ash/editor/browser/widget/diffEditor/diffEditorWidget.js';
import { MultiDiffEditorWidget } from '../../../src/ash/editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.js';
import { DiffModel } from '../../../src/ash/editor/common/diff/diffModel.js';
import { toLineDiff } from '../../../src/ash/editor/common/diff/lineDiff.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { DiffService } from '../../../src/ash/workbench/services/diff/browser/diffService.js';
import { QuickDiffModelService } from '../../../src/ash/workbench/contrib/scm/browser/quickDiffModel.js';
import { ScmConfiguration } from '../../../src/ash/workbench/contrib/scm/common/scmConfiguration.js';
import { WorkbenchQuickDiffService } from '../../../src/ash/workbench/contrib/scm/browser/workbenchQuickDiffService.js';
import { CodeEditorConfiguration } from '../../../src/ash/workbench/contrib/codeEditor/common/editorConfiguration.js';

const resources = new DisposableStore();
const diffOptions = { ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: false };
const service = new DiffService();
const computation = resources.add(service.createComputationService());
const original = resources.add(new TextModel('same\nbefore 😀 after\nlast'));
const modified = resources.add(new TextModel('same\nbefore 🤖 after\nlast'));
const model = resources.add(new DiffModel({ original, modified, diffProvider: computation, diffOptions }));
const secondOriginal = resources.add(new TextModel('one\n'));
const secondModified = resources.add(new TextModel('one'));
const second = resources.add(new DiffModel({ original: secondOriginal, modified: secondModified, diffProvider: computation, diffOptions }));
const single = resources.add(new DiffEditorWidget({ container: document.getElementById('single')!, model }));
resources.add(new MultiDiffEditorWidget({
	container: document.getElementById('multi')!,
	items: [{ id: 'first', label: 'first.ts', model }, { id: 'second', label: 'second.ts', model: second }],
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

const harness = {
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
	async setQuickDiffWhitespace(setting: 'false' | 'inherit'): Promise<void> {
		await configuration.updateValue(ScmConfiguration.diffDecorationsIgnoreTrimWhitespace, setting);
	},
	async setDiffWhitespace(ignore: boolean): Promise<void> {
		await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, ignore);
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
