import fs from "node:fs/promises";
import sharp from "sharp";
import mammoth from "mammoth";
import { parse as parseCsv } from "csv-parse/sync";
import { PDFParse } from "pdf-parse";
import ExcelJS from "exceljs";
import { OutputValidationError, normalizeFormat } from "./index";
import { resolveFfmpegBinary, runCommand } from "./runtime";

async function assertOutputExists(outputPath: string) {
  const stat = await fs.stat(outputPath).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new OutputValidationError("The converted file was not created.");
  }

  if (stat.size <= 0) {
    throw new OutputValidationError("The converted file was empty.");
  }
}

async function validateImageFile(outputPath: string) {
  try {
    const metadata = await sharp(outputPath, { animated: false }).metadata();
    if (!metadata.format) {
      throw new Error("Image metadata could not be read.");
    }
  } catch (error) {
    throw new OutputValidationError("The converted image could not be opened.", { cause: error });
  }
}

async function validatePdfFile(outputPath: string) {
  const parser = new PDFParse({ data: await fs.readFile(outputPath) });

  try {
    const info = await parser.getInfo();
    if (!info.total) {
      throw new Error("PDF parser did not report any pages.");
    }
  } catch (error) {
    throw new OutputValidationError("The converted PDF could not be parsed.", { cause: error });
  } finally {
    await parser.destroy();
  }
}

async function validateDocxFile(outputPath: string) {
  try {
    await mammoth.extractRawText({ path: outputPath });
  } catch (error) {
    throw new OutputValidationError("The converted DOCX file could not be read.", {
      cause: error,
    });
  }
}

async function validateTextFile(outputPath: string) {
  await fs.readFile(outputPath, "utf8").catch((error) => {
    throw new OutputValidationError("The converted text file could not be opened.", {
      cause: error,
    });
  });
}

async function validateJsonFile(outputPath: string) {
  const raw = await fs.readFile(outputPath, "utf8").catch((error) => {
    throw new OutputValidationError("The converted JSON file could not be opened.", {
      cause: error,
    });
  });

  try {
    JSON.parse(raw);
  } catch (error) {
    throw new OutputValidationError("The converted JSON file was not valid JSON.", {
      cause: error,
    });
  }
}

async function validateCsvFile(outputPath: string) {
  const raw = await fs.readFile(outputPath, "utf8").catch((error) => {
    throw new OutputValidationError("The converted CSV file could not be opened.", {
      cause: error,
    });
  });

  try {
    parseCsv(raw, {
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
  } catch (error) {
    throw new OutputValidationError("The converted CSV file was not valid CSV.", {
      cause: error,
    });
  }
}

async function validateXlsxFile(outputPath: string) {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    if (workbook.worksheets.length === 0) {
      throw new Error("Workbook did not contain any sheets.");
    }
  } catch (error) {
    throw new OutputValidationError("The converted XLSX file could not be read.", {
      cause: error,
    });
  }
}

async function validateMediaFile(outputPath: string) {
  try {
    await runCommand(
      resolveFfmpegBinary(),
      ["-v", "error", "-i", outputPath, "-f", "null", "-"],
      {
        label: "media validation",
        timeoutMs: 20_000,
      },
    );
  } catch (error) {
    throw new OutputValidationError("The converted media file could not be decoded.", {
      cause: error,
    });
  }
}

export async function validateOutputFile(outputPath: string, targetFormat: string) {
  await assertOutputExists(outputPath);

  switch (normalizeFormat(targetFormat)) {
    case "png":
    case "jpg":
    case "webp":
      await validateImageFile(outputPath);
      return;
    case "pdf":
      await validatePdfFile(outputPath);
      return;
    case "docx":
      await validateDocxFile(outputPath);
      return;
    case "txt":
      await validateTextFile(outputPath);
      return;
    case "json":
      await validateJsonFile(outputPath);
      return;
    case "csv":
      await validateCsvFile(outputPath);
      return;
    case "xlsx":
      await validateXlsxFile(outputPath);
      return;
    case "gif":
    case "mp3":
    case "wav":
    case "ogg":
    case "mp4":
      await validateMediaFile(outputPath);
      return;
    default:
      return;
  }
}
