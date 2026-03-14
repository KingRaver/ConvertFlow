import { useState, useCallback, useRef, useEffect } from "react";
import LaserFlow from "@/components/LaserFlow";
import {
  Upload,
  FileText,
  Image,
  Music,
  Video,
  Table,
  X,
  Download,
  Loader2,
  AlertCircle,
  ArrowRight,
  RefreshCw,
  Lock,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { SUPPORTED_CONVERSIONS, FORMAT_CATEGORIES } from "@shared/schema";
import { uploadAndConvert, checkConversionStatus, downloadFile } from "@/lib/api";
import {
  ConversionAbortedError,
  ConversionConnectionError,
  ConversionTimeoutError,
  pollConversionUntilSettled,
} from "@/lib/conversionPolling";
import {
  buildAcceptAttribute,
  getFileExtension,
  validateFilesForRoute,
} from "@/lib/fileRules";

interface FileItem {
  id: string;
  file: File;
  sourceFormat: string;
  targetFormat: string;
  status: "pending" | "uploading" | "processing" | "completed" | "failed";
  progress: number;
  conversionId?: number;
  outputFilename?: string | null;
  error?: string;
  convertedSize?: number | null;
  resultMessage?: string | null;
  expiresAt?: string | null;
}

interface NoticeState {
  tone: "error" | "info";
  text: string;
}

function getFormatIcon(format: string) {
  for (const cat of Object.values(FORMAT_CATEGORIES)) {
    if (cat.formats.includes(format)) {
      switch (cat.icon) {
        case "FileText":
          return <FileText className="w-4 h-4" />;
        case "Image":
          return <Image className="w-4 h-4" />;
        case "Music":
          return <Music className="w-4 h-4" />;
        case "Video":
          return <Video className="w-4 h-4" />;
        case "Table":
          return <Table className="w-4 h-4" />;
      }
    }
  }

  return <FileText className="w-4 h-4" />;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatExpiry(expiresAt?: string | null) {
  if (!expiresAt) {
    return null;
  }

  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

interface FileConverterProps {
  presetFrom?: string;
  presetTo?: string;
}

export default function FileConverter({ presetFrom, presetTo }: FileConverterProps) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeControllersRef = useRef<Record<string, AbortController>>({});
  const isPresetRoute = Boolean(presetFrom && presetTo);

  useEffect(() => {
    return () => {
      Object.values(activeControllersRef.current).forEach((controller) => controller.abort());
    };
  }, []);

  const cancelConversion = useCallback((id: string) => {
    activeControllersRef.current[id]?.abort();
    delete activeControllersRef.current[id];
  }, []);

  const addFiles = useCallback(
    (selectedFiles: FileList | File[]) => {
      const validation = validateFilesForRoute(Array.from(selectedFiles), presetFrom);
      const items: FileItem[] = validation.accepted.map((file) => {
        const ext = getFileExtension(file.name);
        const validTargets = SUPPORTED_CONVERSIONS[ext] || [];
        const defaultTarget =
          presetTo && validTargets.includes(presetTo) ? presetTo : validTargets[0] || "";

        return {
          id: crypto.randomUUID(),
          file,
          sourceFormat: ext,
          targetFormat: defaultTarget,
          status: "pending",
          progress: 0,
        };
      });

      if (items.length > 0) {
        setFiles((prev) => [...prev, ...items]);
      }

      if (validation.rejected.length > 0) {
        const summary = validation.rejected
          .slice(0, 2)
          .map((issue) => `${issue.fileName}: ${issue.reason}`)
          .join(" ");
        const suffix =
          validation.rejected.length > 2
            ? ` ${validation.rejected.length - 2} more file(s) were rejected.`
            : "";

        setNotice({
          tone: "error",
          text: `${summary}${suffix}`,
        });
      } else {
        setNotice(null);
      }
    },
    [presetFrom, presetTo],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files.length) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const removeFile = useCallback(
    (id: string) => {
      cancelConversion(id);
      setFiles((prev) => prev.filter((file) => file.id !== id));
    },
    [cancelConversion],
  );

  const updateFile = useCallback((id: string, updates: Partial<FileItem>) => {
    setFiles((prev) => prev.map((file) => (file.id === id ? { ...file, ...updates } : file)));
  }, []);

  const setTargetFormat = useCallback(
    (id: string, format: string) => {
      updateFile(id, { targetFormat: format });
    },
    [updateFile],
  );

  const convertFile = useCallback(
    async (item: FileItem) => {
      const controller = new AbortController();
      activeControllersRef.current[item.id] = controller;

      updateFile(item.id, {
        status: "uploading",
        progress: 20,
        error: undefined,
        resultMessage: undefined,
      });

      try {
        const result = await uploadAndConvert(item.file, item.targetFormat);
        updateFile(item.id, {
          status: "processing",
          progress: 50,
          conversionId: result.id,
          outputFilename: result.outputFilename,
          resultMessage: result.resultMessage,
          expiresAt: result.expiresAt,
        });

        const status = await pollConversionUntilSettled({
          id: result.id,
          checkStatus: checkConversionStatus,
          signal: controller.signal,
          onProgress: (progress, nextStatus) => {
            updateFile(item.id, {
              progress,
              resultMessage: nextStatus.resultMessage,
              expiresAt: nextStatus.expiresAt,
            });
          },
        });

        updateFile(item.id, {
          status: "completed",
          progress: 100,
          convertedSize: status.convertedSize,
          outputFilename: status.outputFilename,
          resultMessage: status.resultMessage,
          expiresAt: status.expiresAt,
        });
      } catch (error) {
        if (error instanceof ConversionAbortedError) {
          return;
        }

        const message =
          error instanceof ConversionTimeoutError ||
          error instanceof ConversionConnectionError ||
          error instanceof Error
            ? error.message
            : "Conversion failed.";

        updateFile(item.id, {
          status: "failed",
          error: message,
        });
      } finally {
        delete activeControllersRef.current[item.id];
      }
    },
    [updateFile],
  );

  const convertAll = useCallback(() => {
    setNotice(null);
    files
      .filter((file) => file.status === "pending" && file.targetFormat)
      .forEach((file) => {
        void convertFile(file);
      });
  }, [convertFile, files]);

  const handleDownload = useCallback(
    async (item: FileItem) => {
      if (!item.outputFilename) {
        return;
      }

      try {
        await downloadFile(item.outputFilename, item.file.name, item.targetFormat);
      } catch (error) {
        setNotice({
          tone: "error",
          text: error instanceof Error ? error.message : "Download failed.",
        });
      }
    },
    [],
  );

  const hasFiles = files.length > 0;
  const pendingFiles = files.filter((file) => file.status === "pending" && file.targetFormat);
  const accept = buildAcceptAttribute(presetFrom);

  return (
    <div className="w-full max-w-2xl mx-auto" data-testid="file-converter">
      <div
        className={`
          relative rounded-xl border-2 border-dashed transition-all duration-200 cursor-pointer
          ${
            isDragging
              ? "border-primary bg-primary/5 scale-[1.01]"
              : hasFiles
                ? "border-border bg-card"
                : "border-border hover:border-primary/50 bg-card hover:bg-primary/[0.02]"
          }
        `}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => !hasFiles && fileInputRef.current?.click()}
        data-testid="drop-zone"
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={accept}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) {
              addFiles(e.target.files);
            }
            e.currentTarget.value = "";
          }}
          data-testid="input-file"
        />

        {!hasFiles && (
          <div className="absolute -top-[400px] left-1/2 -translate-x-1/2 w-screen h-[400px] pointer-events-none">
            <LaserFlow
              color="#0d9488"
              horizontalBeamOffset={0.1}
              verticalBeamOffset={-0.5}
              verticalSizing={777.7}
              horizontalSizing={12.1}
              wispDensity={55}
              wispSpeed={10}
              wispIntensity={25}
              flowSpeed={0.5}
              flowStrength={0.66}
              fogIntensity={5.95}
              fogScale={888.88}
              fogFallSpeed={1.21}
              decay={1.33}
              falloffStart={3.69}
            />
          </div>
        )}

        {!hasFiles ? (
          <div className="flex flex-col items-center justify-center py-16 px-6">
            <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
              <Upload className="w-6 h-6 text-primary" />
            </div>
            <p className="text-base font-medium mb-1">
              Drop files here or click to browse
            </p>
            <p className="text-sm text-muted-foreground mb-4 text-center">
              {isPresetRoute
                ? `This route only accepts .${presetFrom} files and converts them to .${presetTo}.`
                : "Convert documents, images, audio, video, and data files with guest or account-backed job tracking."}
            </p>
            <div className="flex flex-wrap gap-1.5 justify-center">
              {(isPresetRoute
                ? [presetFrom?.toUpperCase(), presetTo?.toUpperCase()].filter(Boolean)
                : ["PDF", "DOCX", "PNG", "JPG", "MP4", "MP3", "CSV", "XLSX"]
              ).map((format) => (
                <Badge key={format} variant="secondary" className="text-xs font-normal">
                  .{format?.toLowerCase()}
                </Badge>
              ))}
            </div>
          </div>
        ) : (
          <div className="p-4 space-y-2">
            {files.map((item) => (
              <FileRow
                key={item.id}
                item={item}
                isPresetRoute={isPresetRoute}
                onRemove={() => removeFile(item.id)}
                onTargetChange={(format) => setTargetFormat(item.id, format)}
                onDownload={() => void handleDownload(item)}
                onRetry={() => {
                  cancelConversion(item.id);
                  updateFile(item.id, {
                    status: "pending",
                    progress: 0,
                    error: undefined,
                    convertedSize: undefined,
                    conversionId: undefined,
                    outputFilename: undefined,
                    resultMessage: undefined,
                  });
                }}
              />
            ))}

            <div className="flex items-center gap-2 pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                className="text-sm"
                data-testid="button-add-more"
              >
                <Upload className="w-3.5 h-3.5 mr-1.5" />
                Add more
              </Button>

              <div className="flex-1" />

              {pendingFiles.length > 0 && (
                <Button
                  onClick={convertAll}
                  size="sm"
                  className="text-sm font-medium"
                  data-testid="button-convert-all"
                >
                  Convert {pendingFiles.length > 1 ? `all ${pendingFiles.length}` : "file"}
                  <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {notice && (
        <p
          className={`mt-3 text-xs flex items-center gap-1.5 ${
            notice.tone === "error" ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          <AlertCircle className="w-3.5 h-3.5" />
          {notice.text}
        </p>
      )}

      <p className="mt-3 text-xs text-muted-foreground text-center">
        Uploads can stay guest-scoped or account-scoped, source files are deleted after processing,
        and completed jobs expire automatically.
      </p>
    </div>
  );
}

function FileRow({
  item,
  isPresetRoute,
  onRemove,
  onTargetChange,
  onDownload,
  onRetry,
}: {
  item: FileItem;
  isPresetRoute: boolean;
  onRemove: () => void;
  onTargetChange: (fmt: string) => void;
  onDownload: () => void;
  onRetry: () => void;
}) {
  const targets = SUPPORTED_CONVERSIONS[item.sourceFormat] || [];
  const isActive = item.status === "uploading" || item.status === "processing";
  const expiresLabel = formatExpiry(item.expiresAt);

  return (
    <div
      className="flex items-center gap-3 p-3 rounded-lg bg-background/80 border border-border/60"
      data-testid={`file-row-${item.id}`}
    >
      <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-muted/70 text-muted-foreground shrink-0">
        {getFormatIcon(item.sourceFormat)}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate" data-testid={`text-filename-${item.id}`}>
            {item.file.name}
          </span>
          <span className="text-xs text-muted-foreground shrink-0">
            {formatFileSize(item.file.size)}
          </span>
        </div>

        {isActive && (
          <Progress value={item.progress} className="h-1 mt-1.5" data-testid={`progress-${item.id}`} />
        )}

        {item.resultMessage && (
          <p className="text-xs text-muted-foreground mt-1">{item.resultMessage}</p>
        )}

        {item.status === "completed" && expiresLabel && (
          <p className="text-[11px] text-muted-foreground mt-1">
            Job record expires around {expiresLabel}.
          </p>
        )}

        {item.status === "failed" && (
          <p className="text-xs text-destructive mt-1">{item.error}</p>
        )}
      </div>

      {item.status === "pending" && targets.length > 0 && (
        <div className="flex items-center gap-2 shrink-0">
          <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />
          {isPresetRoute ? (
            <div className="flex items-center gap-1 text-xs text-muted-foreground rounded-md border border-border px-2.5 h-8">
              <Lock className="w-3 h-3" />
              .{item.targetFormat.toUpperCase()}
            </div>
          ) : (
            <Select value={item.targetFormat} onValueChange={onTargetChange}>
              <SelectTrigger className="w-[90px] h-8 text-xs" data-testid={`select-format-${item.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {targets.map((target) => (
                  <SelectItem key={target} value={target} className="text-xs">
                    .{target.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {isActive && (
        <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
      )}

      {item.status === "completed" && item.outputFilename && (
        <Button
          variant="default"
          size="sm"
          onClick={onDownload}
          className="shrink-0 text-xs h-8"
          data-testid={`button-download-${item.id}`}
        >
          <Download className="w-3.5 h-3.5 mr-1" />
          Download
        </Button>
      )}

      {item.status === "completed" && !item.outputFilename && (
        <div className="flex items-center gap-1.5 text-xs text-primary shrink-0">
          <CheckCircle2 className="w-4 h-4" />
          Completed
        </div>
      )}

      {item.status === "failed" && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onRetry}
          className="shrink-0 text-xs h-8"
          data-testid={`button-retry-${item.id}`}
        >
          <RefreshCw className="w-3.5 h-3.5 mr-1" />
          Retry
        </Button>
      )}

      {(item.status === "pending" || item.status === "completed" || item.status === "failed") && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          className="shrink-0 w-8 h-8 p-0 text-muted-foreground hover:text-destructive"
          data-testid={`button-remove-${item.id}`}
        >
          <X className="w-3.5 h-3.5" />
        </Button>
      )}
    </div>
  );
}
