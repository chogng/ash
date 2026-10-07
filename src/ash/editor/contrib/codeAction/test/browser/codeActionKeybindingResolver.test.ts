import assert from 'node:assert/strict';
import { test } from 'mocha';
import { createLanguageFeatureEditor } from '../../../../test/browser/testLanguageFeatureEditor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyMod, KeyCode } from '../../../../../base/common/keyCodes.js';
import { decodeKeybinding } from '../../../../../base/common/keybindings.js';
import { operatingSystem } from '../../../../../base/common/platform.js';
import { getKeybindingLabel } from '../../../../../base/common/keybindingLabels.js';
import { CodeActionKeybindingResolver } from '../../browser/codeActionKeybindingResolver.js';

test('code action shortcut resolves the most specific kind and respects preferred-only rules', () => {
	using fixture = createLanguageFeatureEditor();
	using broad = KeybindingsRegistry.registerKeybindingRule({ command: 'editor.action.refactor', keybinding: KeyMod.CtrlCmd | KeyCode.KeyR });
	using specific = KeybindingsRegistry.registerKeybindingRule({
		command: 'editor.action.codeAction', keybinding: KeyMod.CtrlCmd | KeyCode.KeyE,
		args: [{ kind: 'refactor.extract' }],
	});
	using preferred = KeybindingsRegistry.registerKeybindingRule({
		command: 'editor.action.codeAction', keybinding: KeyMod.CtrlCmd | KeyCode.KeyP,
		args: [{ kind: 'refactor.extract', preferred: true }],
	});
	const resolve = fixture.editor.invokeWithinContext(accessor => accessor.get(IInstantiationService).createInstance(CodeActionKeybindingResolver).getResolver());
	const keybindings = fixture.editor.invokeWithinContext(accessor => accessor.get(IKeybindingService));
	assert.equal(getKeybindingLabel(resolve({ title: 'Extract', kind: 'refactor.extract.function' })!),
		getKeybindingLabel(keybindings.resolveKeybinding(decodeKeybinding(KeyMod.CtrlCmd | KeyCode.KeyE, operatingSystem)!)));
	assert.equal(getKeybindingLabel(resolve({ title: 'Preferred extract', kind: 'refactor.extract', isPreferred: true })!),
		getKeybindingLabel(keybindings.resolveKeybinding(decodeKeybinding(KeyMod.CtrlCmd | KeyCode.KeyP, operatingSystem)!)));
	assert.equal(resolve({ title: 'Unrelated', kind: 'quickfix' }), undefined);
});
