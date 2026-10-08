import type { Cosmograph } from "@cosmograph/cosmograph"
import { getInternalApi } from "@cosmograph/cosmograph/cosmograph/internal.js"
import { installMetadataNodeOrder } from "./metadata-node-order.ts"

type LayerState = {
  controller?: ReturnType<typeof installMetadataNodeOrder>
  generation: number
  pending?: Promise<void>
}

const layers = new WeakMap<Cosmograph, LayerState>()

function identifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

/** Match the blanks/nulls normalized by prepare-data, without treating zero as empty. */
export function emptyMetadataQuery(table: string, index: string, metadata: string) {
  const value = identifier(metadata)
  return `SELECT ${identifier(index)} FROM ${identifier(table)} WHERE ${value} IS NULL OR LOWER(REGEXP_REPLACE(CAST(${value} AS VARCHAR), '^[[:space:]]+|[[:space:]]+$', '', 'g')) IN ('', '-', 'nan', 'null', 'na', 'n/a', 'none', 'undefined')`
}

/** Query only missing node IDs; do not download or reorder the full metadata table. */
export function updateMetadataLayering(graph: Cosmograph, colorBy?: string): Promise<void> {
  let state = layers.get(graph)
  if (!state) {
    state = { generation: 0 }
    layers.set(graph, state)
  }
  const current = state
  const generation = ++current.generation
  current.pending = (async () => {
    const api = getInternalApi(graph)
    const config = await graph.getConfig()
    let indices: number[] = []
    if (colorBy) {
      if (!api.dbCoordinator || !config.pointIndexBy) {
        throw new Error("The network metadata is not ready.")
      }
      const rows = await api.dbCoordinator.query(
        emptyMetadataQuery(graph.pointsTableName, config.pointIndexBy, colorBy)
      )
      if (!rows) throw new Error("Could not read empty metadata nodes.")
      // Arrow .get() respects null validity, unlike the underlying typed array.
      const column = rows.getChildAt(0)
      if (!column) throw new Error("Could not read empty metadata node indices.")
      indices = Array.from(column, Number)
    }
    // A slow query for the previous field must never replace the current order.
    if (generation !== current.generation) return
    current.controller ??= installMetadataNodeOrder(graph)
    current.controller.setEmptyIndices(indices)
    api.cosmos?.render()
  })()
  return current.pending
}

export async function waitForMetadataLayering(graph: Cosmograph) {
  // React can start a newer field update while a previous query is completing.
  let pending: Promise<void> | undefined
  do {
    pending = layers.get(graph)?.pending
    await pending
  } while (pending !== layers.get(graph)?.pending)
}

export function disposeMetadataLayering(graph: Cosmograph) {
  const state = layers.get(graph)
  if (!state) return
  ++state.generation
  state.controller?.dispose()
  layers.delete(graph)
}
