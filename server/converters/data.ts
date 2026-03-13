import fs from "node:fs/promises";
import { parse as parseCsv } from "csv-parse/sync";
import { stringify as stringifyCsv } from "csv-stringify/sync";
import XLSX from "xlsx";
import { type RegisteredConverterAdapter } from "./index";
import { withTimeout } from "./runtime";

type Row = Record<string, string | number | boolean | null>;

function readCsvRows(csvText: string) {
  return parseCsv(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Row[];
}

function getColumns(rows: Row[]) {
  const columns = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      columns.add(key);
    }
  }

  return Array.from(columns);
}

function writeWorkbook(rows: Row[], outputPath: string) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows, {
    header: getColumns(rows),
  });
  XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
  XLSX.writeFile(workbook, outputPath);
}

function readWorkbookRows(inputPath: string) {
  const workbook = XLSX.readFile(inputPath);
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    return [];
  }

  return XLSX.utils.sheet_to_json<Row>(workbook.Sheets[firstSheetName], {
    defval: "",
  });
}

function stringifyRows(rows: Row[]) {
  const columns = getColumns(rows);
  if (columns.length === 0) {
    return "";
  }

  return stringifyCsv(rows, {
    columns,
    header: true,
  });
}

function createDataAdapter(
  sourceFormat: string,
  targetFormat: string,
  convert: (inputPath: string, outputPath: string) => Promise<void>,
): RegisteredConverterAdapter {
  return {
    family: "data",
    sourceFormat,
    targetFormat,
    engineName: "xlsx+csv",
    async convert(inputPath, outputPath) {
      await withTimeout(
        () => convert(inputPath, outputPath),
        `${sourceFormat}->${targetFormat} data conversion`,
      );
    },
  };
}

export const dataAdapters: RegisteredConverterAdapter[] = [
  createDataAdapter("csv", "xlsx", async (inputPath, outputPath) => {
    const rows = readCsvRows(await fs.readFile(inputPath, "utf8"));
    writeWorkbook(rows, outputPath);
  }),
  createDataAdapter("csv", "json", async (inputPath, outputPath) => {
    const rows = readCsvRows(await fs.readFile(inputPath, "utf8"));
    await fs.writeFile(outputPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  }),
  createDataAdapter("xlsx", "csv", async (inputPath, outputPath) => {
    const rows = readWorkbookRows(inputPath);
    await fs.writeFile(outputPath, stringifyRows(rows), "utf8");
  }),
  createDataAdapter("xlsx", "json", async (inputPath, outputPath) => {
    const rows = readWorkbookRows(inputPath);
    await fs.writeFile(outputPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  }),
];
