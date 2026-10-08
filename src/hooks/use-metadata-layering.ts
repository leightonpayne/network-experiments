import { useEffect, type RefObject } from "react"
import type { CosmographRef } from "@cosmograph/react"
import { toast } from "sonner"
import { disposeMetadataLayering, updateMetadataLayering } from "@/lib/metadata-layering"

export function useMetadataLayering(
  graphRef: RefObject<CosmographRef | null>,
  ready: boolean,
  colorBy?: string
) {
  useEffect(() => {
    const graph = graphRef.current
    if (!ready || !graph) return
    return () => disposeMetadataLayering(graph)
  }, [graphRef, ready])

  useEffect(() => {
    const graph = graphRef.current
    if (!ready || !graph) return
    let cancelled = false
    void updateMetadataLayering(graph, colorBy).catch((error: unknown) => {
      if (cancelled) return
      toast.error("Could not order nodes by metadata", {
        description: error instanceof Error ? error.message : "Try reloading the network.",
      })
    })
    return () => { cancelled = true }
  }, [graphRef, ready, colorBy])
}
