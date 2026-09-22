import { addDisposableListener } from '../../../src/ash/base/browser/dom.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { DiffEditorWidget } from '../../../src/ash/editor/browser/widget/diffEditor/diffEditorWidget.js';
import { MultiDiffEditorWidget } from '../../../src/ash/editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.js';
import { DiffModel } from '../../../src/ash/editor/common/diff/diffModel.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { DiffService } from '../../../src/ash/workbench/services/diff/browser/diffService.js';
import { QuickDiffModelService } from '../../../src/ash/workbench/contrib/scm/browser/quickDiffModel.js';
import { WorkbenchQuickDiffService } from '../../../src/ash/workbench/contrib/scm/browser/workbenchQuickDiffService.js';

const resources = new DisposableStore();
const service = new DiffService();
const computation = resources.add(service.createComputationService());
const original = resources.add(new TextModel('same\nbefore 😀 after\nlast'));
const modified = resources.add(new TextModel('same\nbefore 🤖 after\nlast'));
const model = resources.add(new DiffModel({ original, modified, computationService: computation }));
const secondOriginal = resources.add(new TextModel('one\n'));
const secondModified = resources.add(new TextModel('one'));
const second = resources.add(new DiffModel({ original: secondOriginal, modified: secondModified, computationService: computation }));
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
const quickDiff = resources.add(new QuickDiffModelService(baselines, service));
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
		const controller = new AbortController();
		const running = computation.compute({ original: { version: 1, text }, modified: { version: 1, text: text.split('\n').reverse().join('\n') } }, controller.signal);
		const outcome = running.then(() => 'completed', error => (error as Error).name);
		await new Promise(resolve => setTimeout(resolve, 50));
		controller.abort();
		const next = await computation.compute({ original: { version: 2, text: 'old' }, modified: { version: 2, text: 'new' } }, new AbortController().signal);
		return { outcome: await outcome, kinds: next.rows.map(row => row.kind) };
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
