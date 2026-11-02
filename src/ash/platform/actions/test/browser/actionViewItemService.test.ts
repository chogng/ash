import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IActionViewItemService } from '../../browser/actionViewItemService.js';
import { MenuId } from '../../common/actions.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { getSingletonServiceDescriptors } from '../../../instantiation/common/extensions.js';

test('Action presentations register per menu and window, propagate invalidation and retire their listeners', () => {
	using lifetime = new DisposableStore();
	const create = () => {
		const services = lifetime.add(new InstantiationService());
		return lifetime.add(services.createInstance(getSingletonServiceDescriptors().find(([id]) => id === IActionViewItemService)![1]) as IActionViewItemService & IDisposable);
	};
	const first = create();
	const second = create();
	const changed = lifetime.add(new Emitter<void>());
	const menus: string[] = [];
	lifetime.add(first.onDidChange(menu => menus.push(menu.id)));
	const factory = () => undefined;
	const registration = first.register(MenuId.ChatExecute, MenuId.ChatExecuteQueue, factory, changed.event);
	assert.equal(first.lookUp(MenuId.ChatExecute, MenuId.ChatExecuteQueue), factory);
	assert.equal(second.lookUp(MenuId.ChatExecute, MenuId.ChatExecuteQueue), undefined);
	assert.throws(() => first.register(MenuId.ChatExecute, MenuId.ChatExecuteQueue, factory), /already registered/);
	changed.fire();
	assert.deepEqual(menus, ['ChatExecute', 'ChatExecute']);
	registration.dispose();
	changed.fire();
	assert.equal(first.lookUp(MenuId.ChatExecute, MenuId.ChatExecuteQueue), undefined);
	assert.deepEqual(menus, ['ChatExecute', 'ChatExecute', 'ChatExecute']);
	const replacement = first.register(MenuId.ChatExecute, MenuId.ChatExecuteQueue, factory, changed.event);
	(first as IActionViewItemService & { dispose(): void; }).dispose();
	assert.equal(first.lookUp(MenuId.ChatExecute, MenuId.ChatExecuteQueue), undefined);
	const count = menus.length;
	changed.fire(); replacement.dispose();
	assert.equal(menus.length, count);
});
