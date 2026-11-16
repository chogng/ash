import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import { ISCMService, type ISCMProvider } from '../../common/scm.js';
import { SCMService } from '../../common/scmService.js';
import { SCMViewService } from '../../browser/scmViewService.js';

suite('SCM active repository', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('an editor restored before discovery follows its most specific repository', () => {
		using f = fixture(URI.file('/workspace/nested/file.ts'));
		f.register('other', URI.file('/other'));
		assert.equal(f.views.activeRepository?.id, 'other');
		f.register('workspace', URI.file('/workspace'));
		assert.equal(f.views.activeRepository?.id, 'workspace');
		f.register('nested', URI.file('/workspace/nested'));
		assert.equal(f.views.activeRepository?.id, 'nested');
		f.open(URI.file('/workspace/file.ts'));
		assert.equal(f.views.activeRepository?.id, 'workspace');
	});

	test('manual selection survives discovery and duplicate editor events until the file changes', () => {
		using f = fixture(URI.file('/workspace/file.ts'));
		f.register('workspace', URI.file('/workspace'));
		f.register('manual', URI.file('/manual'));
		f.views.selectRepository('manual');
		f.register('unrelated', URI.file('/unrelated'));
		f.open(URI.file('/workspace/file.ts'));
		assert.equal(f.views.activeRepository?.id, 'manual');
		f.open(URI.file('/workspace/file.ts').with({ fragment: 'line-2' }));
		assert.equal(f.views.activeRepository?.id, 'manual');
		f.open(URI.file('/workspace/another.ts'));
		assert.equal(f.views.activeRepository?.id, 'workspace');
	});

	test('removal resolves the remaining owner and notifications only report selection changes', () => {
		using f = fixture(URI.parse('remote://host/workspace/nested/file.ts'));
		const changes: (string | undefined)[] = [];
		f.add(f.views.onDidChangeActiveRepository(repository => changes.push(repository?.id)));
		f.register('parent', URI.parse('remote://host/workspace'));
		const nested = f.register('nested', URI.parse('remote://host/workspace/nested'));
		f.register('another-host', URI.parse('remote://other/workspace/nested'));
		f.open(URI.parse('remote://host/workspace/nested/file.ts'));
		nested.dispose();
		assert.deepEqual(changes, ['parent', 'nested', 'parent']);
	});

	test('production construction requires the editor dependency', () => {
		using services = new InstantiationService();
		using scm = services.createInstance(SCMService);
		services.registerInstance(ISCMService, scm);
		assert.throws(() => services.createInstance(SCMViewService), /editorService/u);
	});
});

function fixture(initial: URI) {
	const resources = new DisposableStore();
	const changed = resources.add(new Emitter<void>());
	let activeEditor: IResourceEditorInput = { resource: initial };
	const editor = {
		...emptyEditorServiceState,
		get activeEditor() { return activeEditor; },
		onDidActiveEditorChange: changed.event,
	} satisfies IEditorService;
	const scm = resources.add(new SCMService());
	const services = resources.add(new InstantiationService());
	services.registerInstance(ISCMService, scm);
	services.registerInstance(IEditorService, editor);
	const views = resources.add(services.createInstance(SCMViewService));
	return Object.assign(resources, {
		views,
		open: (resource: URI) => { activeEditor = { resource }; changed.fire(); },
		register: (id: string, rootUri: URI) => resources.add(scm.registerSCMProvider({
			id, rootUri, providerId: 'test', label: id, groups: [], onDidChangeResources: Event.None,
			input: { value: '', placeholder: '', enabled: false, canAccept: false, buttonLabel: '', buttonTooltip: '', accept: async () => undefined },
			activeRepositoryName: undefined, statusBarCommands: [], statusMessage: '', isBusy: false,
			refresh: async () => { }, activate: async () => { },
		} satisfies ISCMProvider)),
	});
}
