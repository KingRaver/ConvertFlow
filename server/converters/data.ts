import fs from "node:fs/promises";
import { parse as parseCsv } from "csv-parse/sync";
import { stringify as stringifyCsv } from "csv-stringify/sync";
import ExcelJS from "exceljs";
import { type ConversionOptions, type RegisteredConverterAdapter } from "./index";
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

async function writeWorkbook(rows: Row[], outputPath: string) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  const columns = getColumns(rows);
  worksheet.columns = columns.map((key) => ({ header: key, key }));
  worksheet.addRows(rows);
  await workbook.xlsx.writeFile(outputPath);
}

async function readWorkbookRows(inputPath: string): Promise<Row[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return [];

  const headers: string[] = [];
  worksheet.getRow(1).eachCell((cell) => {
    headers.push(String(cell.value ?? ""));
  });

  const rows: Row[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const record: Row = {};
    headers.forEach((header, i) => {
      const cell = row.getCell(i + 1);
      const val = cell.value;
      record[header] =
        val === null || val === undefined
          ? null
          : typeof val === "object" && "result" in val
            ? (val.result as string | number | boolean | null)
            : (val as string | number | boolean);
    });
    rows.push(record);
  });
  return rows;
}

function stringifyRows(rows: Row[]) {
  const columns = getColumns(rows);
  if (columns.length === 0) return "";
  return stringifyCsv(rows, { columns, header: true });
}

function createDataAdapter(
  sourceFormat: string,
  targetFormat: string,
  convert: (inputPath: string, outputPath: string, options?: ConversionOptions) => Promise<void>,
): RegisteredConverterAdapter {
  return {
    family: "data",
    sourceFormat,
    targetFormat,
    engineName: "exceljs+csv",
    async convert(inputPath, outputPath, options) {
      await withTimeout(
        () => convert(inputPath, outputPath, options),
        `${sourceFormat}->${targetFormat} data conversion`,
      );
    },
  };
}

export const dataAdapters: RegisteredConverterAdapter[] = [
  createDataAdapter("csv", "xlsx", async (inputPath, outputPath) => {
    const rows = readCsvRows(await fs.readFile(inputPath, "utf8"));
    await writeWorkbook(rows, outputPath);
  }),
  createDataAdapter("csv", "json", async (inputPath, outputPath) => {
    const rows = readCsvRows(await fs.readFile(inputPath, "utf8"));
    await fs.writeFile(outputPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  }),
  createDataAdapter("xlsx", "csv", async (inputPath, outputPath) => {
    const rows = await readWorkbookRows(inputPath);
    await fs.writeFile(outputPath, stringifyRows(rows), "utf8");
  }),
  createDataAdapter("xlsx", "json", async (inputPath, outputPath) => {
    const rows = await readWorkbookRows(inputPath);
    await fs.writeFile(outputPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  }),
];
