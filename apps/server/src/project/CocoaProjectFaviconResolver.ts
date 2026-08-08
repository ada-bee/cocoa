import * as ProviderProjectFaviconResolver from "./ProviderProjectFaviconResolver.ts";

/**
 * Cocoa resolves project icons through the owning provider. Older clients that
 * do not identify their durable project receive the stable missing-icon marker.
 */
export const layer = ProviderProjectFaviconResolver.layer;
