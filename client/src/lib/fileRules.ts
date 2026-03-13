import { SUPPORTED_CONVERSIONS } from "@shared/schema";

export interface FileValidationIssue {
  fileName: string;
  reason: string;
}

export interface FileValidationResult<T> {
  accepted: T[];
  rejected: FileValidationIssue[];
}

export function getFileExtension(fileName: string): string {
  return fileName.split(".").pop()?.trim().toLowerCase() ?? "";
}

export function buildAcceptAttribute(presetFrom?: string): string {
  if (presetFrom) {
    return `.${presetFrom}`;
  }

  return Object.keys(SUPPORTED_CONVERSIONS)
    .map((format) => `.${format}`)
    .join(",");
}

export function validateFilesForRoute<T extends { name: string }>(
  files: T[],
  presetFrom?: string,
): FileValidationResult<T> {
  return files.reduce<FileValidationResult<T>>(
    (result, file) => {
      const extension = getFileExtension(file.name);

      if (!SUPPORTED_CONVERSIONS[extension]) {
        result.rejected.push({
          fileName: file.name,
          reason: `Unsupported file format: .${extension || "unknown"}.`,
        });
        return result;
      }

      if (presetFrom && extension !== presetFrom) {
        result.rejected.push({
          fileName: file.name,
          reason: `This page only accepts .${presetFrom} files.`,
        });
        return result;
      }

      result.accepted.push(file);
      return result;
    },
    { accepted: [], rejected: [] },
  );
}
