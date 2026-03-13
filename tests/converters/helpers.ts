import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph } from "docx";
import ExcelJS from "exceljs";
import { resolveFfmpegBinary, runCommand } from "../../server/converters/runtime";

export async function withTempDir<T>(run: (dir: string) => Promise<T>) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "convertflow-test-"));

  try {
    return await run(dir);
  } finally {
    await fsp.rm(dir, { force: true, recursive: true }).catch(() => undefined);
  }
}

export function fixturePath(name: string) {
  return path.join(process.cwd(), "tests", "fixtures", name);
}

export async function copyFixture(name: string, outputPath: string) {
  await fsp.copyFile(fixturePath(name), outputPath);
}

export function hasTextutil() {
  const bin = process.platform === "darwin" ? "/usr/bin/textutil" : "textutil";
  try {
    execFileSync(bin, ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export async function createPngFixture(outputPath: string) {
  await sharp({
    create: {
      width: 96,
      height: 64,
      channels: 4,
      background: "#2266aa",
    },
  })
    .png()
    .toFile(outputPath);
}

export async function createJpgFixture(outputPath: string) {
  await sharp({
    create: {
      width: 96,
      height: 64,
      channels: 3,
      background: "#d87a16",
    },
  })
    .jpeg({ quality: 90 })
    .toFile(outputPath);
}

export async function createWebpFixture(outputPath: string) {
  await sharp({
    create: {
      width: 96,
      height: 64,
      channels: 3,
      background: "#4a9f58",
    },
  })
    .webp({ quality: 90 })
    .toFile(outputPath);
}

export async function createBmpFixture(outputPath: string) {
  const intermediatePngPath = `${outputPath}.png`;

  try {
    await sharp({
      create: {
        width: 96,
        height: 64,
        channels: 3,
        background: "#7c5cff",
      },
    })
      .png()
      .toFile(intermediatePngPath);

    await runCommand(
      resolveFfmpegBinary(),
      ["-y", "-i", intermediatePngPath, outputPath],
      { label: "BMP fixture generation" },
    );
  } finally {
    await fsp.rm(intermediatePngPath, { force: true }).catch(() => undefined);
  }
}

export async function createTiffFixture(outputPath: string) {
  await sharp({
    create: {
      width: 96,
      height: 64,
      channels: 3,
      background: "#ffaa22",
    },
  })
    .tiff()
    .toFile(outputPath);
}

export async function createSvgFixture(outputPath: string) {
  await copyFixture("sample.svg", outputPath);
}

export async function createTextFixture(outputPath: string) {
  await copyFixture("sample.txt", outputPath);
}

export async function createCsvFixture(outputPath: string) {
  await copyFixture("sample.csv", outputPath);
}

export async function createDocxFixture(outputPath: string) {
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph("ConvertFlow DOCX fixture."),
          new Paragraph("Second paragraph for extraction tests."),
        ],
      },
    ],
  });

  await fsp.writeFile(outputPath, await Packer.toBuffer(document));
}

export async function createDocFixture(outputPath: string) {
  const sourcePath = `${outputPath}.txt`;
  await createTextFixture(sourcePath);

  try {
    await runCommand(
      process.platform === "darwin" ? "/usr/bin/textutil" : "textutil",
      ["-convert", "doc", "-output", outputPath, sourcePath],
      { label: "legacy DOC fixture generation" },
    );
  } finally {
    await fsp.rm(sourcePath, { force: true }).catch(() => undefined);
  }
}

export async function createPdfFixture(outputPath: string) {
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({
      margin: 48,
      size: "LETTER",
    });
    const stream = fs.createWriteStream(outputPath);
    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.on("error", reject);
    doc.pipe(stream);
    doc.fontSize(18).text("ConvertFlow PDF fixture");
    doc.moveDown();
    doc.fontSize(12).text("Second line for text extraction and rendering.");
    doc.end();
  });
}

export async function createXlsxFixture(outputPath: string) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");

  worksheet.columns = [
    { header: "name", key: "name" },
    { header: "score", key: "score" },
    { header: "active", key: "active" },
  ];
  worksheet.addRow({ name: "Ada", score: 42, active: true });
  worksheet.addRow({ name: "Linus", score: 35, active: false });

  await workbook.xlsx.writeFile(outputPath);
}

export async function createWavFixture(outputPath: string) {
  await runCommand(
    resolveFfmpegBinary(),
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1.0",
      "-c:a",
      "pcm_s16le",
      outputPath,
    ],
    { label: "WAV fixture generation" },
  );
}

export async function createMp3Fixture(outputPath: string) {
  await runCommand(
    resolveFfmpegBinary(),
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:duration=1.0",
      "-c:a",
      "libmp3lame",
      "-q:a",
      "2",
      outputPath,
    ],
    { label: "MP3 fixture generation" },
  );
}

export async function createMp4Fixture(outputPath: string) {
  await runCommand(
    resolveFfmpegBinary(),
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=#336699:s=160x90:d=1.2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:duration=1.2",
      "-shortest",
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      outputPath,
    ],
    { label: "MP4 fixture generation" },
  );
}

export async function createGifFixture(outputPath: string) {
  const intermediateMp4Path = `${outputPath}.mp4`;

  try {
    await createMp4Fixture(intermediateMp4Path);
    await runCommand(
      resolveFfmpegBinary(),
      [
        "-y",
        "-i",
        intermediateMp4Path,
        "-vf",
        "fps=10,scale=120:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
        "-loop",
        "0",
        outputPath,
      ],
      { label: "GIF fixture generation" },
    );
  } finally {
    await fsp.rm(intermediateMp4Path, { force: true }).catch(() => undefined);
  }
}

export function assertOutputFile(outputPath: string, expectedExtension: string) {
  const stat = fs.statSync(outputPath);
  return {
    extension: path.extname(outputPath),
    size: stat.size,
    matchesExtension: path.extname(outputPath) === `.${expectedExtension}`,
  };
}
