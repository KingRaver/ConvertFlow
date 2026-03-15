import { Link } from "wouter";
import {
  ArrowRight,
  ShieldCheck,
  FolderTree,
  Clock3,
  Route,
  Layers3,
  Wrench,
  FileText,
  Image,
  Music,
  Video,
  Table,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import FileConverter from "@/components/FileConverter";
import DarkVeil from "@/components/DarkVeil";
import { POPULAR_CONVERSIONS, FORMAT_CATEGORIES } from "@shared/schema";

const FEATURES = [
  {
    icon: Route,
    title: "Route-aware validation",
    description: "Preset pages only accept the source format they advertise and lock the target route.",
  },
  {
    icon: ShieldCheck,
    title: "Visitor-scoped jobs",
    description: "Each browser gets its own visitor id so job status and history stay isolated.",
  },
  {
    icon: Clock3,
    title: "Automatic expiry",
    description: "Source uploads are deleted after processing and completed job records expire automatically.",
  },
  {
    icon: FolderTree,
    title: "Broad coverage",
    description: "Document, image, audio, video, and data routes are available from a single upload flow.",
  },
  {
    icon: Wrench,
    title: "Real conversion engine",
    description: "Uploads now produce real output files that can be downloaded through the existing job flow.",
  },
  {
    icon: Layers3,
    title: "Shareable pages",
    description: "Direct links now resolve normally, so route pages behave like real landing pages instead of hash fragments.",
  },
];

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  FileText: <FileText className="w-4 h-4" />,
  Image: <Image className="w-4 h-4" />,
  Music: <Music className="w-4 h-4" />,
  Video: <Video className="w-4 h-4" />,
  Table: <Table className="w-4 h-4" />,
};

export default function Home() {
  return (
    <div className="flex flex-col">
      <section className="relative overflow-hidden" data-testid="section-hero">
        <div className="absolute inset-0 pointer-events-none">
          <DarkVeil hueShift={48} noiseIntensity={0} scanlineIntensity={0} speed={0.5} scanlineFrequency={0.5} warpAmount={0} />
        </div>
        <div className="absolute inset-0 bg-gradient-to-b from-background/60 to-background pointer-events-none" />
        <div className="relative mx-auto max-w-6xl px-4 sm:px-6 pt-16 pb-12 sm:pt-24 sm:pb-16">
          <div className="text-center mb-10">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight mb-3" data-testid="text-hero-title">
              Convert Files Instantly
            </h1>
            <p className="text-sm sm:text-base text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              Fast, secure, and free file conversions. Drop your files and get results in seconds.
            </p>
          </div>

          <FileConverter />
        </div>

        <div className="relative mx-auto max-w-6xl px-4 sm:px-6 py-12 sm:py-16" data-testid="section-popular">
          <h2 className="text-lg font-semibold text-center mb-2">Popular Conversion Routes</h2>
          <p className="text-sm text-muted-foreground text-center mb-8">
            Jump into the most common source-to-target paths and start a conversion immediately.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {POPULAR_CONVERSIONS.map((conversion) => (
              <Link key={conversion.slug} href={`/convert/${conversion.slug}`}>
                <div
                  className="flex items-center gap-2.5 p-3 rounded-lg border border-border/60 bg-card hover:bg-accent/50 transition-colors cursor-pointer group"
                  data-testid={`link-conversion-${conversion.slug}`}
                >
                  <Badge variant="outline" className="text-[10px] font-mono shrink-0">
                    .{conversion.from}
                  </Badge>
                  <ArrowRight className="w-3 h-3 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
                  <Badge variant="outline" className="text-[10px] font-mono shrink-0">
                    .{conversion.to}
                  </Badge>
                  <span className="text-xs text-muted-foreground ml-auto hidden sm:block">
                    {conversion.label}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-card/50 border-y border-border/40" data-testid="section-features">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-12 sm:py-16">
          <h2 className="text-lg font-semibold text-center mb-2">What This Build Delivers</h2>
          <p className="text-sm text-muted-foreground text-center mb-10">
            The current app ships real conversion engines with both guest uploads and account-backed history.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map((feature) => (
              <div
                key={feature.title}
                className="flex flex-col items-center p-5 rounded-xl bg-background border border-border/60 text-center"
                data-testid={`feature-${feature.title.toLowerCase().replace(/\s/g, "-")}`}
              >
                <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center mb-3">
                  <feature.icon className="w-4 h-4 text-primary" />
                </div>
                <h3 className="text-sm font-semibold mb-1">{feature.title}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative overflow-hidden" data-testid="section-categories">
        <div className="absolute inset-0 pointer-events-none">
          <DarkVeil hueShift={48} noiseIntensity={0} scanlineIntensity={0} speed={0.5} scanlineFrequency={0.5} warpAmount={0} />
        </div>
        <div className="absolute inset-0 bg-gradient-to-b from-background to-background/60 pointer-events-none" />
        <div className="relative mx-auto max-w-6xl px-4 sm:px-6 py-12 sm:py-16">
          <h2 className="text-lg font-semibold text-center mb-2">Available Format Coverage</h2>
          <p className="text-sm text-muted-foreground text-center mb-8">
            These categories back the current route map and conversion engine registry.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {Object.entries(FORMAT_CATEGORIES).map(([key, category]) => (
              <div
                key={key}
                className="flex flex-col items-center p-4 rounded-xl border border-border/60 bg-card text-center"
              >
                <div className="flex items-center justify-center gap-2 mb-3">
                  <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center text-primary">
                    {CATEGORY_ICONS[category.icon]}
                  </div>
                  <span className="text-sm font-medium">{category.label}</span>
                </div>
                <div className="flex flex-wrap justify-center gap-1">
                  {category.formats.map((format) => (
                    <Badge key={format} variant="secondary" className="text-[10px] font-mono">
                      .{format}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-2xl bg-primary/[0.04] border border-primary/10 p-8 sm:p-12 text-center mt-12" data-testid="section-cta">
            <h2 className="text-lg font-semibold mb-2">Ready to review the routes?</h2>
            <p className="text-sm text-muted-foreground mb-6 max-w-xl mx-auto">
              Upload a file to start a conversion, or inspect the full list of supported format routes.
            </p>
            <div className="flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
              <Button
                className="w-full sm:w-auto"
                onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
                data-testid="button-cta-upload"
              >
                Start Converting
                <ArrowRight className="w-4 h-4 ml-1.5" />
              </Button>
              <Button
                asChild
                className="w-full sm:w-auto"
                variant="outline"
                data-testid="button-cta-formats"
              >
                <Link href="/formats">
                  Browse Formats
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
