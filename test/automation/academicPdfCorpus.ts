import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * An externally hosted, open-access scientific PDF used only by the opt-in corpus regression.
 *
 * The regular editor suite intentionally remains hermetic. This corpus verifies the real PDF.js
 * path against publisher PDFs of materially different sizes. The digest makes a publisher-side
 * replacement explicit instead of accidentally accepting a challenge or error document.
 */
export interface AcademicPdfCorpusDocument {
	readonly fileName: string;
	readonly pageCount: number;
	readonly sha256: string;
	readonly sourceUrl: string;
	readonly title: string;
}

export const academicPdfCorpus: readonly AcademicPdfCorpusDocument[] = Object.freeze([
	{
		fileName: "open-science-5-pages.pdf",
		pageCount: 5,
		sha256: "1a130711d83237a2a7e16ee40c3148a66fd54eeac2a359c42f7204eb9fda9a0e",
		sourceUrl: "https://arxiv.org/pdf/2405.12132",
		title: "A Vision on Open Science for the Evolution of Software Engineering Research and Practice",
	},
	{
		fileName: "martial-arts-10-pages.pdf",
		pageCount: 10,
		sha256: "443a30245c023826adeb0f35cda7b8d29ff0526463081b4edce158edbaeb5ab9",
		sourceUrl: "https://www.frontiersin.org/articles/10.3389/fpsyg.2021.696943/pdf",
		title: "Aggression Dimensions Among Athletes Practising Martial Arts and Combat Sports",
	},
	{
		fileName: "auditory-cortex-20-pages.pdf",
		pageCount: 20,
		sha256: "f26414cac435d8941557702d929f88da16b7dc9e8446d083f711231452c82c2d",
		sourceUrl: "https://journals.plos.org/plosbiology/article/file?id=10.1371%2Fjournal.pbio.3000207&type=printable",
		title: "Asymmetric sampling in human auditory cortex reveals spectral processing hierarchy",
	},
	{
		fileName: "answer-bot-26-pages.pdf",
		pageCount: 26,
		sha256: "8c90cf89756e6b76d5b7cc770e9683587ec3d2a05e0f19e5d795949b58564259",
		sourceUrl: "https://journals.plos.org/plosone/article/file?id=10.1371%2Fjournal.pone.0268081&type=printable",
		title: "The Answer Bot Effect (ABE): A powerful new form of influence made possible by intelligent personal assistants and search engines",
	},
	{
		fileName: "scientific-data-239-pages.pdf",
		pageCount: 239,
		sha256: "eeca47de919429d9a6703e0fdeebac6a6e00f6a29ed7d34527391fb4d006580f",
		sourceUrl: "https://www.ncbi.nlm.nih.gov/books/n/nap10785/pdf/",
		title: "The Role of Scientific and Technical Data and Information in the Public Domain: Proceedings of a Symposium",
	},
]);

/** Downloads and validates the opt-in academic PDF corpus into one isolated test workspace. */
export async function downloadAcademicPdfCorpus(directory: string): Promise<void> {
	for (const document of academicPdfCorpus) {
		const response = await fetch(document.sourceUrl, { signal: AbortSignal.timeout(120_000) });
		if (!response.ok) throw new Error(`Could not download '${document.title}': HTTP ${response.status}`);
		const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
		if (!contentType.includes("application/pdf")) {
			throw new Error(`Could not download '${document.title}': expected application/pdf but received '${contentType || "unknown"}'`);
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (!hasPdfSignature(bytes)) throw new Error(`Could not download '${document.title}': response does not have a PDF signature`);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		if (sha256 !== document.sha256) {
			throw new Error(`The source PDF for '${document.title}' changed: expected SHA-256 ${document.sha256}, received ${sha256}`);
		}
		await writeFile(join(directory, document.fileName), bytes);
	}
}

function hasPdfSignature(bytes: Uint8Array): boolean {
	return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}
