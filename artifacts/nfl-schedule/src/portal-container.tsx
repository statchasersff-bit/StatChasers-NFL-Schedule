import { createContext, useContext } from 'react';

/**
 * Where Radix portals (select menus, dropdowns, tooltips) should mount.
 *
 * Standalone, `null` means Radix's default of document.body. Inside the WordPress embed the app
 * lives in a shadow root, and a portal escaping to document.body would land outside that root —
 * unstyled, because the bundle's CSS is scoped to the shadow tree.
 */
export const PortalContainerContext = createContext<HTMLElement | null>(null);

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? undefined;
}
