import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const source = resolve(repositoryRoot, "resources/win32/ash.svg");
const executableOutput = resolve(repositoryRoot, "resources/win32/ash.ico");
const windowOutput = resolve(repositoryRoot, "resources/win32/ash-512.png");
const sizes = [16, 24, 32, 48, 64, 128, 256] as const;

export async function generateWindowsApplicationIcons(): Promise<{ executable: Buffer; window: Buffer }> {
  const artwork = (await readFile(source)).toString("base64");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const renderPng = async (size: number): Promise<Buffer> => {
      const dataUrl = await page.evaluate(async ({ artwork, size }) => {
        const image = new Image();
        image.src = `data:image/svg+xml;base64,${artwork}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        canvas.getContext("2d")!.drawImage(image, 0, 0, size, size);
        return canvas.toDataURL("image/png");
      }, { artwork, size });
      return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
    };
    const images: Buffer[] = [];
    for (const size of sizes) {
      images.push(await renderPng(size));
    }

    const directory = Buffer.alloc(6 + images.length * 16);
    directory.writeUInt16LE(1, 2);
    directory.writeUInt16LE(images.length, 4);
    let offset = directory.length;
    for (const [index, image] of images.entries()) {
      const entry = 6 + index * 16;
      directory[entry] = sizes[index] === 256 ? 0 : sizes[index];
      directory[entry + 1] = directory[entry];
      directory.writeUInt16LE(1, entry + 4);
      directory.writeUInt16LE(32, entry + 6);
      directory.writeUInt32LE(image.length, entry + 8);
      directory.writeUInt32LE(offset, entry + 12);
      offset += image.length;
    }
    return { executable: Buffer.concat([directory, ...images]), window: await renderPng(512) };
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  const check = process.argv.slice(2).includes("--check");
  const generated = await generateWindowsApplicationIcons();
  if (check) {
    const executable = await readFile(executableOutput);
    const window = await readFile(windowOutput);
    if (!generated.executable.equals(executable) || !generated.window.equals(window)) {
      throw new Error("Windows application icons are stale. Run pnpm app-icon:generate.");
    }
    console.log(`Validated ${sizes.length} Windows executable icon sizes and the 512px window icon.`);
  } else {
    await writeFile(executableOutput, generated.executable);
    await writeFile(windowOutput, generated.window);
    console.log(`Generated ${sizes.length} Windows executable icon sizes and the 512px window icon.`);
  }
}
