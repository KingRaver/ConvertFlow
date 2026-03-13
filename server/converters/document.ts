import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Document, Packer, Paragraph } from "docx";
import mammoth from "mammoth";
import PDFDocument from "pdfkit";
import { PDFParse } from "pdf-parse";
import sharp from "sharp";
import { stringify as stringifyCsv } from "csv-stringify/sync";
import { ConversionError, type RegisteredConverterAdapter } from "./index";
import { resolveTextutilBinary, runCommand, withTimeout } from "./runtime";

function sanitizeExtractedText(text: string) {
  return text
    .replace(/^\s*-- \d+ of \d+ --\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractPdfText(inputPath: string) {
  const parser = new PDFParse({ data: await fs.readFile(inputPath) });

  try {
    const result = await parser.getText();
    const text = sanitizeExtractedText(result.text);
    if (!text) {
      throw new ConversionError("No extractable text was found in the PDF.");
    }

    return text;
  } catch (error) {
    if (error instanceof ConversionError) {
      throw error;
    }

    throw new ConversionError("Failed to extract text from the PDF.", "conversion_failed", {
      cause: error,
    });
  } finally {
    await parser.destroy();
  }
}

async function renderPdfPage(inputPath: string) {
  const parser = new PDFParse({ data: await fs.readFile(inputPath) });

  try {
    const screenshot = await parser.getScreenshot({
      first: 1,
      imageDataUrl: false,
      scale: 1.5,
    });

    if (screenshot.pages.length === 0) {
      throw new ConversionError("The PDF did not contain any pages.");
    }

    return Buffer.from(screenshot.pages[0].data);
  } catch (error) {
    if (error instanceof ConversionError) {
      throw error;
    }

    throw new ConversionError("Failed to render a page from the PDF.", "conversion_failed", {
      cause: error,
    });
  } finally {
    await parser.destroy();
  }
}

async function writeTextPdf(text: string, outputPath: string) {
  await withTimeout(
    () =>
      new Promise<void>((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: "LETTER" });
        const writable = createWriteStream(outputPath);

        writable.on("finish", resolve);
        writable.on("error", reject);
        doc.on("error", reject);
        doc.pipe(writable);

        const lines = (text.trim() ? text : " ").split(/\r?\n/);
        for (const line of lines) {
          doc.text(line || " ");
        }
        doc.end();
      }),
    "PDF generation",
  );
}

async function writeDocxFromText(text: string, outputPath: string) {
  await withTimeout(
    async () => {
      const lines = (text.trim() ? text : " ").split(/\r?\n/);
      const document = new Document({
        sections: [
          {
            children: lines.map((line) => new Paragraph(line || " ")),
          },
        ],
      });

      await fs.writeFile(outputPath, await Packer.toBuffer(document));
    },
    "DOCX generation",
  );
}

async function readTextFile(inputPath: string) {
  return fs.readFile(inputPath, "utf8");
}

async function readDocxText(inputPath: string) {
  const result = await mammoth.extractRawText({ path: inputPath });
  const text = result.value.trim();
  if (!text) {
    throw new ConversionError("No extractable text was found in the DOCX file.");
  }

  return text;
}

async function readLegacyDocText(inputPath: string) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "convertflow-doc-"));
  const outputPath = path.join(tempDir, "converted.txt");

  try {
    await runCommand(
      resolveTextutilBinary(),
      ["-convert", "txt", "-output", outputPath, inputPath],
      { label: "Legacy DOC text extraction" },
    );

    const text = (await fs.readFile(outputPath, "utf8")).trim();
    if (!text) {
      throw new ConversionError("No extractable text was found in the DOC file.");
    }

    return text;
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

function createDocumentAdapter(
  sourceFormat: string,
  targetFormat: string,
  engineName: string,
  convert: (inputPath: string, outputPath: string) => Promise<void>,
): RegisteredConverterAdapter {
  return {
    family: "document",
    sourceFormat,
    targetFormat,
    engineName,
    convert,
  };
}

export const documentAdapters: RegisteredConverterAdapter[] = [
  createDocumentAdapter("docx", "pdf", "mammoth+pdfkit", async (inputPath, outputPath) => {
    await writeTextPdf(await readDocxText(inputPath), outputPath);
  }),
  createDocumentAdapter("doc", "pdf", "textutil+pdfkit", async (inputPath, outputPath) => {
    await writeTextPdf(await readLegacyDocText(inputPath), outputPath);
  }),
  createDocumentAdapter("pdf", "txt", "pdf-parse", async (inputPath, outputPath) => {
    await fs.writeFile(outputPath, `${await extractPdfText(inputPath)}\n`, "utf8");
  }),
  createDocumentAdapter("pdf", "png", "pdf-parse", async (inputPath, outputPath) => {
    await fs.writeFile(outputPath, await renderPdfPage(inputPath));
  }),
  createDocumentAdapter("pdf", "jpg", "pdf-parse+sharp", async (inputPath, outputPath) => {
    await sharp(await renderPdfPage(inputPath))
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 90 })
      .toFile(outputPath);
  }),
  createDocumentAdapter("pdf", "docx", "pdf-parse+docx", async (inputPath, outputPath) => {
    await writeDocxFromText(await extractPdfText(inputPath), outputPath);
  }),
  createDocumentAdapter("txt", "pdf", "pdfkit", async (inputPath, outputPath) => {
    await writeTextPdf(await readTextFile(inputPath), outputPath);
  }),
  createDocumentAdapter("txt", "docx", "docx", async (inputPath, outputPath) => {
    await writeDocxFromText(await readTextFile(inputPath), outputPath);
  }),
  createDocumentAdapter("docx", "txt", "mammoth", async (inputPath, outputPath) => {
    await fs.writeFile(outputPath, `${await readDocxText(inputPath)}\n`, "utf8");
  }),
  createDocumentAdapter("doc", "txt", "textutil", async (inputPath, outputPath) => {
    await fs.writeFile(outputPath, `${await readLegacyDocText(inputPath)}\n`, "utf8");
  }),
  createDocumentAdapter("pdf", "csv", "pdf-parse+csv-stringify", async (inputPath, outputPath) => {
    const text = await extractPdfText(inputPath);
    const rows = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => [line.replace(/\s{2,}/g, "\t").split("\t")].flat());
    await fs.writeFile(outputPath, stringifyCsv(rows), "utf8");
  }),
];
