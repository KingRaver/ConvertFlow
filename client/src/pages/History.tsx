import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CONVERSION_STATUSES, SUPPORTED_FORMATS } from "@shared/schema";
import { Link, useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { downloadFile, getConversions, type ConversionResponse } from "@/lib/api";

const PAGE_SIZE = 20;

function formatFileSize(bytes?: number | null) {
  if (!bytes) {
    return "—";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value?: string | null) {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getStatusVariant(status: ConversionResponse["status"]) {
  switch (status) {
    case "completed":
      return "default";
    case "failed":
      return "destructive";
    case "pending":
    case "processing":
    default:
      return "secondary";
  }
}

export default function History() {
  const { isAuthenticated, isLoading } = useAuth();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>("all");
  const [format, setFormat] = useState<string>("all");

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate("/login");
    }
  }, [isAuthenticated, isLoading, navigate]);

  const historyQuery = useQuery({
    queryKey: ["history", page, status, format],
    queryFn: () =>
      getConversions({
        page,
        limit: PAGE_SIZE,
        status: status === "all" ? undefined : status,
        format: format === "all" ? undefined : format,
      }),
    enabled: isAuthenticated,
  });

  async function handleDownload(conversion: ConversionResponse) {
    if (!conversion.outputFilename || !conversion.originalName || !conversion.targetFormat) {
      return;
    }

    try {
      await downloadFile(
        conversion.outputFilename,
        conversion.originalName,
        conversion.targetFormat,
      );
    } catch (error) {
      toast({
        title: "Download failed",
        description: error instanceof Error ? error.message : "Download failed.",
        variant: "destructive",
      });
    }
  }

  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6" data-testid="page-history-loading">
        <Card className="border-border/60">
          <CardContent className="py-8 text-sm text-muted-foreground">
            Loading account history...
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6" data-testid="page-history-locked">
        <Card className="border-border/60">
          <CardHeader>
            <CardTitle className="text-xl">Sign in required</CardTitle>
            <CardDescription>
              Account history is only available to authenticated users.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-3">
            <Link href="/login">
              <Button>Sign in</Button>
            </Link>
            <Link href="/register">
              <Button variant="outline">Create account</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const items = historyQuery.data?.items ?? [];
  const totalPages = historyQuery.data?.totalPages ?? 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16" data-testid="page-history">
      <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Conversion history</h1>
          <p className="text-sm text-muted-foreground">
            Review account-owned jobs, filter by status or format, and redownload completed output files.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="w-full sm:w-44">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Status
            </label>
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
            >
              <SelectTrigger data-testid="select-history-status">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {CONVERSION_STATUSES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="w-full sm:w-44">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Format
            </label>
            <Select
              value={format}
              onValueChange={(value) => {
                setFormat(value);
                setPage(1);
              }}
            >
              <SelectTrigger data-testid="select-history-format">
                <SelectValue placeholder="All formats" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All formats</SelectItem>
                {SUPPORTED_FORMATS.map((item) => (
                  <SelectItem key={item} value={item}>
                    .{item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <Card className="border-border/60">
        <CardContent className="pt-6">
          {historyQuery.isLoading ? (
            <div className="py-8 text-sm text-muted-foreground">Loading conversions...</div>
          ) : historyQuery.isError ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {historyQuery.error instanceof Error
                ? historyQuery.error.message
                : "Failed to load conversion history."}
            </div>
          ) : items.length === 0 ? (
            <div className="py-8 text-sm text-muted-foreground">
              No conversions matched the current filters.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((conversion) => (
                  <TableRow key={conversion.id}>
                    <TableCell className="font-medium">
                      {conversion.originalName ?? `Conversion #${conversion.id}`}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 text-xs">
                        <Badge variant="outline">.{conversion.originalFormat ?? "?"}</Badge>
                        <span className="text-muted-foreground">to</span>
                        <Badge variant="outline">.{conversion.targetFormat ?? "?"}</Badge>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={getStatusVariant(conversion.status)}>
                        {conversion.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatFileSize(conversion.convertedSize ?? conversion.fileSize)}</TableCell>
                    <TableCell>{formatDate(conversion.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      {conversion.status === "completed" && conversion.outputFilename ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleDownload(conversion)}
                          data-testid={`button-history-download-${conversion.id}`}
                        >
                          Download
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {conversion.resultMessage ?? "Unavailable"}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <div className="mt-6 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {historyQuery.data
                ? `Page ${historyQuery.data.page} of ${Math.max(totalPages, 1)}`
                : "Page 1"}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((currentPage) => Math.max(currentPage - 1, 1))}
                disabled={page <= 1 || historyQuery.isLoading}
                data-testid="button-history-prev"
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((currentPage) => currentPage + 1)}
                disabled={
                  historyQuery.isLoading ||
                  totalPages === 0 ||
                  page >= totalPages
                }
                data-testid="button-history-next"
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
