import { start } from '../../editor.worker.start.js';
import { EditorWorker, editorWorkerWireCodec } from './editorWebWorker.js';
import { WorkerTextModelSyncServer } from './textModelSync/textModelSync.impl.js';

start(({ port, resources }) => {
	resources.add(new WorkerTextModelSyncServer(port, editorWorkerWireCodec, new EditorWorker()));
});
