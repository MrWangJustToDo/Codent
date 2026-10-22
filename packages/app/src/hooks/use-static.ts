import { useStdout } from "ink";
import { type JSX } from "react";
import { createState, markRaw } from "reactivity-store";

export const useStatic = createState(
  () => ({
    stdoutRef: markRaw({ current: null as ReturnType<typeof useStdout>["stdout"] | null }),
    header: null as JSX.Element | null,
    headerReady: false,
    list: [] as JSX.Element[],
    /**
     * One invalidation signature per row in `list`, same order. Each row's `<StaticRender>`
     * depends only on its own entry, so one row changing no longer re-caches the others.
     */
    itemSigs: [] as string[],
    /**
     * @deprecated
     */
    headerSet: 0,
    /**
     * @deprecated
     */
    listSet: 0,
  }),
  {
    withActions(s) {
      return {
        useInitStdout: () => {
          const result = useStdout();
          s.stdoutRef.current = result.stdout;
        },
        setStaticHeader: (item: JSX.Element) => ((s.header = item), s.headerSet++),
        setStaticHeaderReady: (ready: boolean) => (s.headerReady = ready),
        /**
         * Rows and their signatures are written together: they are positional, so letting
         * them diverge would attach one row's signature to another row's cache.
         */
        setStaticList: (items: JSX.Element[], signatures: string[]) => {
          s.list = items;
          s.itemSigs = signatures;
          s.listSet++;
        },
      };
    },

    // withNamespace: "useStatic",

    withDeepSelector: false,

    withStableSelector: true,
  }
);

useStatic.getLifeCycle().syncUpdateComponent = true;
