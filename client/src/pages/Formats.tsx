import { Link } from "wouter";
import { ArrowRight, FileText, Image, Music, Video, Table } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SUPPORTED_CONVERSIONS, FORMAT_CATEGORIES } from "@shared/schema";
import DarkVeil from "@/components/DarkVeil";

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  FileText: <FileText className="w-5 h-5" />,
  Image: <Image className="w-5 h-5" />,
  Music: <Music className="w-5 h-5" />,
  Video: <Video className="w-5 h-5" />,
  Table: <Table className="w-5 h-5" />,
};

export default function Formats() {
  return (
    <div className="relative overflow-hidden" data-testid="page-formats">
      <div className="absolute inset-0 pointer-events-none">
        <DarkVeil hueShift={48} noiseIntensity={0} scanlineIntensity={0} speed={0.5} scanlineFrequency={0.5} warpAmount={0} />
      </div>
      <div className="absolute inset-0 bg-gradient-to-b from-background/60 to-background pointer-events-none" />
      <div className="relative mx-auto max-w-6xl px-4 sm:px-6 py-12 sm:py-16">
      <div className="text-center mb-10">
        <h1 className="text-xl font-bold tracking-tight mb-2">Supported Format Routes</h1>
        <p className="text-sm text-muted-foreground max-w-lg mx-auto">
          Browse the active source-to-target conversion routes, organized by category.
        </p>
      </div>

      <div className="space-y-8">
        {Object.entries(FORMAT_CATEGORIES).map(([key, cat]) => (
          <div key={key} data-testid={`format-category-${key}`}>
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                {CATEGORY_ICONS[cat.icon]}
              </div>
              <div>
                <h2 className="text-base font-semibold">{cat.label}</h2>
                <p className="text-xs text-muted-foreground">{cat.formats.length} formats</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {cat.formats.map((fmt) => {
                const targets = SUPPORTED_CONVERSIONS[fmt] || [];
                if (targets.length === 0) return null;

                return (
                  <div key={fmt} className="p-3 rounded-lg border border-border/60 bg-card">
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="outline" className="text-xs font-mono">
                        .{fmt.toUpperCase()}
                      </Badge>
                      <ArrowRight className="w-3 h-3 text-muted-foreground" />
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {targets.map((t) => {
                        const slug = `${fmt}-to-${t}`;
                        return (
                          <Link key={t} href={`/convert/${slug}`}>
                            <Badge
                              variant="secondary"
                              className="text-[10px] font-mono cursor-pointer hover:bg-primary/10 hover:text-primary transition-colors"
                            >
                              .{t.toUpperCase()}
                            </Badge>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
    </div>
  );
}
