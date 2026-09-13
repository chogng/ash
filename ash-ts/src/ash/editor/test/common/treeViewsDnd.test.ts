import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DraggedTreeItemsIdentifier, TreeViewsDnDService } from '../../common/services/treeViewsDnd.js';

test('TreeViewsDnDService returns a drag operation exactly once', async () => {
	const service = new TreeViewsDnDService<{ readonly text: string }>();
	const transfer = Promise.resolve({ text: 'tree item' });
	service.addDragOperationTransfer('drag-1', transfer);

	assert.equal(service.removeDragOperationTransfer('drag-1'), transfer);
	assert.equal(service.removeDragOperationTransfer('drag-1'), undefined);
	assert.deepEqual(await transfer, { text: 'tree item' });
});

test('TreeViewsDnDService keeps the latest operation for an identifier', async () => {
	const service = new TreeViewsDnDService<string>();
	service.addDragOperationTransfer('drag-1', Promise.resolve('first'));
	service.addDragOperationTransfer('drag-1', Promise.resolve('second'));

	assert.equal(await service.removeDragOperationTransfer('drag-1'), 'second');
	assert.equal(service.removeDragOperationTransfer(undefined), undefined);
	assert.equal(service.removeDragOperationTransfer('missing'), undefined);
});

test('DraggedTreeItemsIdentifier retains the drag operation identifier', () => {
	const identifier = new DraggedTreeItemsIdentifier('drag-1');
	assert.equal(identifier.identifier, 'drag-1');
});
