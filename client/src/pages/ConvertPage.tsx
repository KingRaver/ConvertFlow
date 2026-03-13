import { useParams, Link } from "wouter";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import FileConverter from "@/components/FileConverter";
import { POPULAR_CONVERSIONS, SUPPORTED_CONVERSIONS } from "@shared/schema";

const FORMAT_DESCRIPTIONS: Record<string, string> = {
  pdf: "PDF (Portable Document Format) is a universal file format that preserves document formatting across devices and platforms. Created by Adobe, it's the standard for sharing documents.",
  docx: "DOCX is Microsoft Word's default document format. It supports rich text formatting, images, tables, and is widely used for business documents and reports.",
  doc: "DOC is the legacy Microsoft Word format. While largely replaced by DOCX, it's still used for compatibility with older software.",
  png: "PNG (Portable Network Graphics) is a lossless image format that supports transparency. Ideal for graphics, screenshots, and images requiring sharp edges.",
  jpg: "JPG/JPEG is the most widely used image format, using lossy compression for smaller file sizes. Best for photographs and complex images.",
  jpeg: "JPEG is the most widely used image format, using lossy compression for smaller file sizes. Best for photographs and complex images.",
  webp: "WebP is a modern image format developed by Google, offering superior compression for both lossy and lossless images. Widely supported by modern browsers.",
  gif: "GIF supports animation and transparency with a limited 256-color palette. Commonly used for short animations and simple graphics.",
  mp4: "MP4 is the most popular video container format, supporting H.264/H.265 video codecs with excellent compression and universal playback support.",
  mp3: "MP3 is the most widely used audio format, using lossy compression to reduce file sizes while maintaining good audio quality.",
  wav: "WAV is an uncompressed audio format that preserves full audio quality. Preferred for professional audio editing and archival.",
  ogg: "OGG Vorbis is an open-source audio format offering good compression quality. Commonly used in gaming and web applications.",
  csv: "CSV (Comma-Separated Values) is a simple text-based data format. Universally supported by spreadsheet applications, databases, and programming languages.",
  xlsx: "XLSX is Microsoft Excel's default spreadsheet format, supporting formulas, charts, formatting, and multiple sheets.",
  json: "JSON (JavaScript Object Notation) is a lightweight data interchange format. Human-readable and widely used in web APIs and configuration files.",
  txt: "TXT is a plain text format with no formatting. Universal compatibility across all operating systems and text editors.",
  svg: "SVG (Scalable Vector Graphics) is an XML-based vector image format. Ideal for logos, icons, and graphics that need to scale without quality loss.",
  bmp: "BMP (Bitmap) is an uncompressed image format native to Windows. Large file sizes but maintains pixel-perfect quality.",
  tiff: "TIFF (Tagged Image File Format) is a flexible, high-quality image format used in publishing, photography, and scanning.",
};

export default function ConvertPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug || "";

  // Parse slug: "pdf-to-docx" -> { from: "pdf", to: "docx" }
  const parts = slug.split("-to-");
  const fromFormat = parts[0] || "";
  const toFormat = parts[1] || "";

  // Map common aliases
  const toFormatMapped = toFormat === "word" ? "docx" : toFormat === "excel" ? "xlsx" : toFormat;

  const validTargets = SUPPORTED_CONVERSIONS[fromFormat] || [];
  const isValid = validTargets.includes(toFormatMapped);

  const fromDesc = FORMAT_DESCRIPTIONS[fromFormat] || `${fromFormat.toUpperCase()} file format.`;
  const toDesc = FORMAT_DESCRIPTIONS[toFormatMapped] || `${toFormatMapped.toUpperCase()} file format.`;

  // Find related conversions
  const related = POPULAR_CONVERSIONS.filter(
    (c) => c.slug !== slug && (c.from === fromFormat || c.to === toFormatMapped)
  ).slice(0, 4);

  if (!isValid) {
    return (
      <div className="mx-auto max-w-2xl px-4 sm:px-6 py-16 text-center" data-testid="convert-page-invalid">
        <h1 className="text-xl font-bold mb-2">Conversion Not Supported</h1>
        <p className="text-sm text-muted-foreground mb-6">
          We don't currently support converting .{fromFormat} to .{toFormatMapped}.
        </p>
        <Link href="/">
          <Button variant="outline">
            <ArrowLeft className="w-4 h-4 mr-1.5" />
            Back to Home
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-12 sm:py-16" data-testid="convert-page">
      <div className="text-center mb-10">
        <div className="flex items-center justify-center gap-3 mb-4">
          <Badge variant="outline" className="text-sm font-mono px-3 py-1">
            .{fromFormat.toUpperCase()}
          </Badge>
          <ArrowRight className="w-4 h-4 text-primary" />
          <Badge variant="outline" className="text-sm font-mono px-3 py-1">
            .{toFormatMapped.toUpperCase()}
          </Badge>
        </div>
        <h1 className="text-xl font-bold tracking-tight mb-2" data-testid="text-convert-title">
          Convert {fromFormat.toUpperCase()} to {toFormatMapped.toUpperCase()}
        </h1>
        <p className="text-sm text-muted-foreground max-w-lg mx-auto">
          Upload a {fromFormat.toUpperCase()} file, track the queued job, and download the
          converted {toFormatMapped.toUpperCase()} output when processing completes.
        </p>
      </div>

      <FileConverter presetFrom={fromFormat} presetTo={toFormatMapped} />

      {/* Format info */}
      <div className="mt-16 grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
        <div className="p-5 rounded-xl border border-border/60 bg-card">
          <div className="flex items-center gap-2 mb-2">
            <Badge variant="secondary" className="text-xs font-mono">.{fromFormat.toUpperCase()}</Badge>
            <span className="text-xs text-muted-foreground">Source format</span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{fromDesc}</p>
        </div>
        <div className="p-5 rounded-xl border border-border/60 bg-card">
          <div className="flex items-center gap-2 mb-2">
            <Badge variant="secondary" className="text-xs font-mono">.{toFormatMapped.toUpperCase()}</Badge>
            <span className="text-xs text-muted-foreground">Target format</span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{toDesc}</p>
        </div>
      </div>

      {/* How it works */}
      <div className="mt-12 max-w-2xl mx-auto">
        <h2 className="text-base font-semibold text-center mb-6">How It Works</h2>
        <div className="grid grid-cols-3 gap-4">
          {[
            { step: "1", title: "Upload", desc: `Drop your .${fromFormat} file` },
            { step: "2", title: "Convert", desc: "The backend runs the matching conversion engine" },
            { step: "3", title: "Download", desc: `Grab the converted .${toFormatMapped} file when it is ready` },
          ].map((s) => (
            <div key={s.step} className="text-center">
              <div className="w-8 h-8 rounded-full bg-primary/10 text-primary text-sm font-semibold flex items-center justify-center mx-auto mb-2">
                {s.step}
              </div>
              <h3 className="text-sm font-medium mb-0.5">{s.title}</h3>
              <p className="text-xs text-muted-foreground">{s.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Related */}
      {related.length > 0 && (
        <div className="mt-12 max-w-2xl mx-auto">
          <h2 className="text-base font-semibold text-center mb-4">Related Conversions</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {related.map((c) => (
              <Link key={c.slug} href={`/convert/${c.slug}`}>
                <div className="flex items-center justify-center gap-2 p-3 rounded-lg border border-border/60 bg-card hover:bg-accent/50 transition-colors cursor-pointer text-center">
                  <Badge variant="outline" className="text-[10px] font-mono">.{c.from}</Badge>
                  <ArrowRight className="w-3 h-3 text-muted-foreground" />
                  <Badge variant="outline" className="text-[10px] font-mono">.{c.to}</Badge>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
