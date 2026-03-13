import fs from "node:fs/promises";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { type ConversionOptions, type RegisteredConverterAdapter, normalizeFormat } from "./index";
import { resolveFfmpegBinary, runCommand, withTimeout } from "./runtime";

function createImagePipeline(inputPath: string) {
  return sharp(inputPath, {
    animated: false,
    density: 300,
    page: 0,
  }).rotate();
}

function getNumericOption(options: ConversionOptions, key: string) {
  const value = options?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getJpegQuality(options: ConversionOptions, fallback = 90) {
  const quality = getNumericOption(options, "quality");
  if (quality === undefined) {
    return fallback;
  }

  return Math.max(1, Math.min(100, Math.round(quality)));
}

function getFfmpegJpegQuality(options: ConversionOptions) {
  const quality = getJpegQuality(options);
  return String(Math.max(2, Math.min(31, Math.round(((100 - quality) / 99) * 29) + 2)));
}

function createSharpAdapter(
  sourceFormat: string,
  targetFormat: string,
  transform: (pipeline: sharp.Sharp, options?: ConversionOptions) => sharp.Sharp,
): RegisteredConverterAdapter {
  return {
    family: "image",
    sourceFormat,
    targetFormat,
    engineName: "sharp",
    async convert(inputPath, outputPath, options) {
      await withTimeout(
        async () => {
          await transform(createImagePipeline(inputPath), options).toFile(outputPath);
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
  args: string[] | ((options?: ConversionOptions) => string[]),
): RegisteredConverterAdapter {
  return {
    family: "image",
    sourceFormat,
    targetFormat,
    engineName: "ffmpeg-static",
    async convert(inputPath, outputPath, options) {
      await runCommand(
        resolveFfmpegBinary(),
        ["-y", "-i", inputPath, ...(typeof args === "function" ? args(options) : args), outputPath],
        { label: `${sourceFormat}->${targetFormat} image conversion` },
      );
    },
  };
}

export const imageAdapters: RegisteredConverterAdapter[] = [
  createSharpAdapter("png", "jpg", (pipeline, options) =>
    pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: getJpegQuality(options) }),
  ),
  createSharpAdapter("png", "webp", (pipeline, options) => pipeline.webp({ quality: getJpegQuality(options) })),
  createSharpAdapter("jpg", "png", (pipeline) => pipeline.png()),
  createSharpAdapter("jpg", "webp", (pipeline, options) => pipeline.webp({ quality: getJpegQuality(options) })),
  createSharpAdapter("webp", "png", (pipeline) => pipeline.png()),
  createSharpAdapter("webp", "jpg", (pipeline, options) =>
    pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: getJpegQuality(options) }),
  ),
  createSharpAdapter("gif", "png", (pipeline) => pipeline.png()),
  createSharpAdapter("gif", "jpg", (pipeline, options) =>
    pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: getJpegQuality(options) }),
  ),
  createSharpAdapter("svg", "png", (pipeline) => pipeline.png()),
  createSharpAdapter("svg", "jpg", (pipeline, options) =>
    pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: getJpegQuality(options) }),
  ),
  createFfmpegImageAdapter("bmp", "png", ["-frames:v", "1"]),
  createFfmpegImageAdapter("bmp", "jpg", (options) => ["-frames:v", "1", "-q:v", getFfmpegJpegQuality(options)]),
  createSharpAdapter("tiff", "png", (pipeline) => pipeline.png()),
  createSharpAdapter("tiff", "jpg", (pipeline, options) =>
    pipeline.flatten({ background: "#ffffff" }).jpeg({ quality: getJpegQuality(options) }),
  ),
  createImageToPdfAdapter("png"),
  createImageToPdfAdapter("jpg"),
];
