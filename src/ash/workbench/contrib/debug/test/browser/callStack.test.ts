import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { GlyphMarginLane } from '../../../../../editor/common/model.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IDebugService } from '../../common/debug.js';
import { CallStackEditorContribution } from '../../browser/callStackEditorContribution.js';
import { MockDebugService } from '../common/mockDebug.js';

for (const resource of [URI.file('/project/main.ts'), URI.parse('ash-remote://ssh-remote+host/project/main.ts')]) {
	test(`paused frame decorations follow selected frame and retire on continue/disposal: ${resource.scheme}`, async () => {
		using model = new TextModel('first\nsecond\nthird', { resource });
		using debug = new MockDebugService({ name: 'main.ts', resource });
		using services = new InstantiationService(new ServiceCollection([IDebugService, debug]));
		using contribution = services.createInstance(CallStackEditorContribution, model);
		assert.equal(model.getAllDecorations().length, 0);
		const session = debug.sessions[0]!;
		debug.activate(session);
		await debug.focusStackFrame({ id: 0, name: 'frame', source: { resource }, lineNumber: 2, columnNumber: 1 });
		assert.equal(model.getAllDecorations().length, 1);
		assert.equal(model.getAllDecorations()[0]!.range.startLineNumber, 2);
		assert.equal(model.getAllDecorations()[0]!.options.glyphMargin?.position, GlyphMarginLane.Right);
		await debug.focusStackFrame({ id: 1, name: 'unknown position', source: { resource }, lineNumber: 0, columnNumber: 0 });
		assert.equal(model.getAllDecorations().length, 0);
		await debug.focusStackFrame({ id: 2, name: 'other file', source: { resource: URI.file('/other.ts') }, lineNumber: 2, columnNumber: 1 });
		assert.equal(model.getAllDecorations().length, 0);
		await debug.focusStackFrame({ id: 3, name: 'frame', source: { resource }, lineNumber: 3, columnNumber: 1 });
		assert.equal(model.getAllDecorations().length, 1);
		await session.continue();
		debug.activate(session);
		assert.equal(model.getAllDecorations().length, 0);
		contribution.dispose();
		assert.equal(model.getAllDecorations().length, 0);
	});
}
