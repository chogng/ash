import { parentPort, workerData } from 'node:worker_threads';
import { readPdf } from './reader.js';
import type { PdfReadRequest } from './requests.js';

try { parentPort!.postMessage({ result: await readPdf(workerData as PdfReadRequest) }); }
catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
