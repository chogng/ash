import assert from 'node:assert/strict';
import { test } from 'mocha';
import { createStringDataTransferItem, VSDataTransfer } from '../../../base/common/dataTransfer.js';
import { ServiceContainer } from '../../../platform/instantiation/common/instantiation.js';
import { ITreeViewsDnDService, registerTreeViewsDnDService } from '../../common/services/treeViewsDndService.js';

test('tree view drag data service is registered with VSDataTransfer', async () => {
	using container = new ServiceContainer();
	registerTreeViewsDnDService(container);
	const service = container.get(ITreeViewsDnDService);
	const transfer = new VSDataTransfer();
	transfer.append('text/plain', createStringDataTransferItem('tree item'));
	service.addDragOperationTransfer('drag-1', Promise.resolve(transfer));

	const consumed = await service.removeDragOperationTransfer('drag-1');
	assert.equal(await consumed?.get('text/plain')?.asString(), 'tree item');
	assert.equal(service.removeDragOperationTransfer('drag-1'), undefined);
});
