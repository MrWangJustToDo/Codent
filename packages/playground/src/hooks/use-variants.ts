import { createState } from "reactivity-store";

import type { VariantDescriptor } from "../webcontainer/scan-variants.js";

export const useVariants = createState(
  () => ({
    variants: [] as VariantDescriptor[],
    activeVariantId: null as string | null,
  }),
  {
    withActions: (state) => ({
      setVariants: (variants: VariantDescriptor[]) => {
        state.variants = variants;
        // Keep the active id valid; default to the first variant.
        if (state.activeVariantId && !variants.some((v) => v.id === state.activeVariantId)) {
          state.activeVariantId = variants[0]?.id ?? null;
        } else if (!state.activeVariantId && variants.length > 0) {
          state.activeVariantId = variants[0]!.id;
        }
      },
      setActive: (id: string) => {
        if (state.variants.some((v) => v.id === id)) {
          state.activeVariantId = id;
        }
      },
      upsert: (variant: VariantDescriptor) => {
        const idx = state.variants.findIndex((v) => v.id === variant.id);
        if (idx === -1) {
          state.variants = [...state.variants, variant];
        } else {
          const next = state.variants.slice();
          next[idx] = variant;
          state.variants = next;
        }
      },
    }),
    withNamespace: "useVariants",
  }
);
