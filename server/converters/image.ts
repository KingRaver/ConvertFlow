import fs from "node:fs/promises";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { type RegisteredConverterAdapter, normalizeFormat } from "./index";
import { resolveFfmpegBinary, runCommand, withTimeout } from "./runtime";

function createImagePipeline(inputPath: string) {
  return sharp(inputPath, {
    animated: false,
    density: 300,
    page: 0,
  }).rotate();
}

function createSharpAdapter(
  sourceFormat: string,
  targetFormat: string,
  transform: (pipeline: sharp.Sharp) => sharp.Sharp,
): RegisteredConverterAdapter {
  return {
    family: "image",
    sourceFormat,
    targetFormat,
    engineName: "sharp",
    async convert(inputPath, outputPath) {
      await withTimeout(
        async () => {
          await transform(createImagePipeline(inputPath)).toFile(outputPath);
        },
        `${sourceFormat}->${targetFormat} image conversion`,
      );
    },
  };
}

function createImageToPdfAdapter(sourceFormat: string): RegisteredConverterAdapter {
  return {
    family: "image",
    sourceFormat,
    targetFormat: "pdf",
    engineName: "pdf-lib",
    async convert(inputPath, outputPath) {
      await withTimeout(
        async () => {
          const normalizedSource = normalizeFormat(sourceFormat);
          const pipeline = createImagePipeline(inputPath);
          const imageBuffer =
            normalizedSource === "png"
              ? await pipeline.png().toBuffer()
              : await pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();

          const pdf = await PDFDocument.create();
          const embedded =
            normalizedSource === "png"
              ? await pdf.embedPng(imageBuffer)
              : await pdf.embedJpg(imageBuffer);

          const page = pdf.addPage([embedded.width, embedded.height]);
          page.drawImage(embedded, {
            x: 0,
            y: 0,
            width: embedded.width,
            height: embedded.height,
          });

          await fs.writeFile(outputPath, await pdf.save());
        },
        `${sourceFormat}->pdf image conversion`,
      );
    },
  };
}

function createFfmpegImageAdapter(
  sourceFormat: string,
  targetFormat: string,
  args: string[],
): RegisteredConverterAdapter {
  return {
    family: "image",
    sourceFormat,
    targetFormat,
    engineName: "ffmpeg-static",
    async convert(inputPath, outputPath) {
      await runCommand(
        resolveFfmpegBinary(),
        ["-y", "-i", inputPath, ...args, outputPath],
        { label: `${sourceFormat}->${targetFormat} image conversion` },
      );
    },
  };
}

export const imageAdapters: RegisteredConverterAdapter[] = [
  createSharpAdapter("png", "jpg", (pipeline) =>
    pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: 90 }),
  ),
  createSharpAdapter("png", "webp", (pipeline) => pipeline.webp({ quality: 90 })),
  createSharpAdapter("jpg", "png", (pipeline) => pipeline.png()),
  createSharpAdapter("jpg", "webp", (pipeline) => pipeline.webp({ quality: 90 })),
  createSharpAdapter("webp", "png", (pipeline) => pipeline.png()),
  createSharpAdapter("webp", "jpg", (pipeline) =>
    pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: 90 }),
  ),
  createSharpAdapter("gif", "png", (pipeline) => pipeline.png()),
  createSharpAdapter("gif", "jpg", (pipeline) =>
    pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: 90 }),
  ),
  createSharpAdapter("svg", "png", (pipeline) => pipeline.png()),
  createSharpAdapter("svg", "jpg", (pipeline) =>
    pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: 90 }),
  ),
  createFfmpegImageAdapter("bmp", "png", ["-frames:v", "1"]),
  createFfmpegImageAdapter("bmp", "jpg", ["-frames:v", "1", "-q:v", "2"]),
  createSharpAdapter("tiff", "png", (pipeline) => pipeline.png()),
  createSharpAdapter("tiff", "jpg", (pipeline) =>
    pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: 90 }),
  ),
  createImageToPdfAdapter("png"),
  createImageToPdfAdapter("jpg"),
];
