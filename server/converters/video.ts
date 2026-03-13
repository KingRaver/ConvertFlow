import { type RegisteredConverterAdapter } from "./index";
import { resolveFfmpegBinary, runCommand } from "./runtime";

function createVideoAdapter(
  sourceFormat: string,
  targetFormat: string,
  args: string[],
): RegisteredConverterAdapter {
  return {
    family: "video",
    sourceFormat,
    targetFormat,
    engineName: "ffmpeg-static",
    async convert(inputPath, outputPath) {
      await runCommand(
        resolveFfmpegBinary(),
        ["-y", "-i", inputPath, ...args, outputPath],
        { label: `${sourceFormat}->${targetFormat} video conversion` },
      );
    },
  };
}

export const videoAdapters: RegisteredConverterAdapter[] = [
  createVideoAdapter("mp4", "gif", [
    "-vf",
    "fps=10,scale=min(480\\,iw):-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
    "-loop",
    "0",
  ]),
  createVideoAdapter("mp4", "mp3", ["-vn", "-c:a", "libmp3lame", "-q:a", "2"]),
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
