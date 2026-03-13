import { ConversionError, routeKey } from "./index";
import { audioAdapters } from "./audio";
import { dataAdapters } from "./data";
import { documentAdapters } from "./document";
import { imageAdapters } from "./image";
import { videoAdapters } from "./video";

const adapters = [...imageAdapters, ...documentAdapters, ...dataAdapters, ...audioAdapters, ...videoAdapters];

const adapterMap = new Map(adapters.map((adapter) => [routeKey(adapter.sourceFormat, adapter.targetFormat), adapter]));

export const registry = {
  getAdapter(sourceFormat: string, targetFormat: string) {
    const adapter = adapterMap.get(routeKey(sourceFormat, targetFormat));
    if (!adapter) {
      throw new ConversionError(
        `No converter is configured for .${sourceFormat} to .${targetFormat}.`,
        "unsupported_route",
      );
    }

    return adapter;
  },

  listAdapters() {
    return adapters.slice();
  },
};
