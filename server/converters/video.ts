import { type ConversionOptions, type RegisteredConverterAdapter } from "./index";
import { resolveFfmpegBinary, runCommand } from "./runtime";

function getBitrateArg(options?: ConversionOptions) {
  const bitrate = options?.bitrateKbps;
  if (typeof bitrate !== "number" || !Number.isFinite(bitrate)) {
    return null;
  }

  return `${Math.max(32, Math.min(320, Math.round(bitrate)))}k`;
}

function getGifFilter(options?: ConversionOptions) {
  const fpsValue = options?.fps;
  const widthValue = options?.width;
  const fps = typeof fpsValue === "number" && Number.isFinite(fpsValue)
    ? Math.max(1, Math.min(30, Math.round(fpsValue)))
    : 10;
  const width = typeof widthValue === "number" && Number.isFinite(widthValue)
    ? Math.max(64, Math.min(1920, Math.round(widthValue)))
    : 480;

  return `fps=${fps},scale=min(${width}\\,iw):-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;
}

function createVideoAdapter(
  sourceFormat: string,
  targetFormat: string,
  args: string[] | ((options?: ConversionOptions) => string[]),
): RegisteredConverterAdapter {
  return {
    family: "video",
    sourceFormat,
    targetFormat,
    engineName: "ffmpeg-static",
    async convert(inputPath, outputPath, options) {
      await runCommand(
        resolveFfmpegBinary(),
        ["-y", "-i", inputPath, ...(typeof args === "function" ? args(options) : args), outputPath],
        { label: `${sourceFormat}->${targetFormat} video conversion` },
      );
    },
  };
}

export const videoAdapters: RegisteredConverterAdapter[] = [
  createVideoAdapter("mp4", "gif", (options) => [
    "-vf",
    getGifFilter(options),
    "-loop",
    "0",
  ]),
  createVideoAdapter("mp4", "mp3", (options) => {
    const bitrate = getBitrateArg(options);
    return bitrate ? ["-vn", "-c:a", "libmp3lame", "-b:a", bitrate] : ["-vn", "-c:a", "libmp3lame", "-q:a", "2"];
  }),
  createVideoAdapter("mp4", "wav", ["-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2"]),
  createVideoAdapter("gif", "mp4", [
    "-movflags",
    "faststart",
    "-an",
    "-pix_fmt",
    "yuv420p",
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos,format=yuv420p",
    "-c:v",
    "libx264",
  ]),
];
