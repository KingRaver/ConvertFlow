import { type ConversionOptions, type RegisteredConverterAdapter } from "./index";
import { resolveFfmpegBinary, runCommand } from "./runtime";

function getBitrateArg(options?: ConversionOptions) {
  const bitrate = options?.bitrateKbps;
  if (typeof bitrate !== "number" || !Number.isFinite(bitrate)) {
    return null;
  }

  return `${Math.max(32, Math.min(320, Math.round(bitrate)))}k`;
}

function createAudioAdapter(
  sourceFormat: string,
  targetFormat: string,
  args: string[] | ((options?: ConversionOptions) => string[]),
): RegisteredConverterAdapter {
  return {
    family: "audio",
    sourceFormat,
    targetFormat,
    engineName: "ffmpeg-static",
    async convert(inputPath, outputPath, options) {
      await runCommand(
        resolveFfmpegBinary(),
        ["-y", "-i", inputPath, ...(typeof args === "function" ? args(options) : args), outputPath],
        { label: `${sourceFormat}->${targetFormat} audio conversion` },
      );
    },
  };
}

export const audioAdapters: RegisteredConverterAdapter[] = [
  createAudioAdapter("mp3", "wav", ["-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2"]),
  createAudioAdapter("mp3", "ogg", (options) => {
    const bitrate = getBitrateArg(options);
    return bitrate ? ["-vn", "-c:a", "libvorbis", "-b:a", bitrate] : ["-vn", "-c:a", "libvorbis", "-q:a", "5"];
  }),
  createAudioAdapter("wav", "mp3", (options) => {
    const bitrate = getBitrateArg(options);
    return bitrate ? ["-vn", "-c:a", "libmp3lame", "-b:a", bitrate] : ["-vn", "-c:a", "libmp3lame", "-q:a", "2"];
  }),
  createAudioAdapter("wav", "ogg", (options) => {
    const bitrate = getBitrateArg(options);
    return bitrate ? ["-vn", "-c:a", "libvorbis", "-b:a", bitrate] : ["-vn", "-c:a", "libvorbis", "-q:a", "5"];
  }),
];
