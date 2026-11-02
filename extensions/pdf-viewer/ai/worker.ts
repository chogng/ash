import { readPdf } from './reader.js';
import type { PdfReadRequest } from './requests.js';

process.once('message', async (request: PdfReadRequest) => {
	try { process.send!({ result: await readPdf(request) }); }
	catch (error) { process.send!({ error: error instanceof Error ? error.message : String(error) }); }
});
