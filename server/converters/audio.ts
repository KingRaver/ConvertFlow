import { type RegisteredConverterAdapter } from "./index";
import { resolveFfmpegBinary, runCommand } from "./runtime";

function createAudioAdapter(
  sourceFormat: string,
  targetFormat: string,
  args: string[],
): RegisteredConverterAdapter {
  return {
    family: "audio",
    sourceFormat,
    targetFormat,
    engineName: "ffmpeg-static",
    async convert(inputPath, outputPath) {
      await runCommand(
        resolveFfmpegBinary(),
        ["-y", "-i", inputPath, ...args, outputPath],
        { label: `${sourceFormat}->${targetFormat} audio conversion` },
      );
    },
  };
}

export const audioAdapters: RegisteredConverterAdapter[] = [
  createAudioAdapter("mp3", "wav", ["-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2"]),
  createAudioAdapter("mp3", "ogg", ["-vn", "-c:a", "libvorbis", "-q:a", "5"]),
  createAudioAdapter("wav", "mp3", ["-vn", "-c:a", "libmp3lame", "-q:a", "2"]),
  createAudioAdapter("wav", "ogg", ["-vn", "-c:a", "libvorbis", "-q:a", "5"]),
];
