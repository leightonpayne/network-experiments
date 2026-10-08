import type { Cosmograph } from "@cosmograph/cosmograph"
import { getInternalApi } from "@cosmograph/cosmograph/cosmograph/internal.js"

type BufferUpload = (data: Float32Array) => unknown
type DrawOptions = { skipSelected: boolean; skipUnselected: boolean }

interface PointData {
  pointsNumber: number
  pointColors: Float32Array
  pointSizes: Float32Array
  pointShapes: Float32Array
  pointImageIndices: Float32Array
  pointImageSizes: Float32Array
}

interface PointRenderer {
  drawPointIndices: BufferUpload
  hoveredPointIndices: BufferUpload
  colorBuffer: BufferUpload
  sizeBuffer: BufferUpload
  shapeBuffer: BufferUpload
  imageIndicesBuffer: BufferUpload
  imageSizesBuffer: BufferUpload
  updatePositions(): void
  updateColor(): void
  updateSize(): void
  updateShape(): void
  updateImageIndices(): void
  updateImageSizes(): void
  drawCommand(options: DrawOptions): unknown
}

interface OrderingRenderer {
  graph: PointData
  points: PointRenderer
  store: { pointsTextureSize: number }
  _isDestroyed?: boolean
}

export interface MetadataNodeOrder {
  setEmptyIndices(indices: Iterable<number>): void
  dispose(): void
}

const attributes = [
  ["updateColor", "colorBuffer", "pointColors", 4],
  ["updateSize", "sizeBuffer", "pointSizes", 1],
  ["updateShape", "shapeBuffer", "pointShapes", 1],
  ["updateImageIndices", "imageIndicesBuffer", "pointImageIndices", 1],
  ["updateImageSizes", "imageSizesBuffer", "pointImageSizes", 1],
] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function")
}

function isRenderer(value: unknown): value is OrderingRenderer {
  if (!isObject(value) || !isObject(value.graph) || !isObject(value.points)
    || !isObject(value.store)) return false
  const { graph, points, store } = value
  return typeof graph.pointsNumber === "number"
    && Number.isSafeInteger(graph.pointsNumber) && graph.pointsNumber >= 0
    && typeof store.pointsTextureSize === "number" && store.pointsTextureSize > 0
    && ["drawPointIndices", "hoveredPointIndices", "updatePositions", "drawCommand"].every(
      (method) => typeof points[method] === "function"
    )
    && attributes.every(([update, buffer, data, stride]) =>
      typeof points[update] === "function"
      && typeof points[buffer] === "function"
      && graph[data] instanceof Float32Array
      && (graph[data] as Float32Array).length >= (graph.pointsNumber as number) * stride
    )
}

/**
 * Cosmos has no public point draw-order API. Change only its display buffers:
 * position/selection textures, graph data, and link endpoints retain their
 * original indices. Keep this version-dependent bridge guarded and isolated.
 */
export function installMetadataNodeOrder(graph: Cosmograph): MetadataNodeOrder {
  const cosmos: unknown = getInternalApi(graph).cosmos
  if (!isRenderer(cosmos)) {
    throw new Error("This network renderer does not support metadata node ordering.")
  }
  const { points } = cosmos
  let order: Uint32Array | undefined
  let mixed = false
  let disposed = false

  const currentOrder = () => {
    // A data rebuild needs a new metadata query. Do not apply old row indices
    // to a replacement dataset while that query is in flight.
    if (order && order.length !== cosmos.graph.pointsNumber) {
      order = undefined
      mixed = false
    }
    return order
  }

  const uploadIndices = () => {
    const sorted = currentOrder()
    const count = cosmos.graph.pointsNumber
    const textureSize = cosmos.store.pointsTextureSize
    const coordinates = new Float32Array(count * 2)
    for (let position = 0; position < count; position++) {
      const index = sorted?.[position] ?? position
      coordinates[position * 2] = index % textureSize
      coordinates[position * 2 + 1] = Math.floor(index / textureSize)
    }
    points.drawPointIndices(coordinates)
    // Hover picking shares sizeBuffer with visible points. Match its order so
    // each hitbox retains the right size and the foreground node wins ties.
    // The shader derives the original node ID from these texture coordinates.
    points.hoveredPointIndices(coordinates)
  }

  const uploadAttribute = (buffer: typeof attributes[number][1],
    data: typeof attributes[number][2], stride: number) => {
    const sorted = currentOrder()
    const source = cosmos.graph[data]
    if (!sorted) {
      points[buffer](source)
      return
    }
    const reordered = new Float32Array(sorted.length * stride)
    for (let position = 0; position < sorted.length; position++) {
      const sourceOffset = sorted[position] * stride
      const targetOffset = position * stride
      for (let component = 0; component < stride; component++) {
        reordered[targetOffset + component] = source[sourceOffset + component]
      }
    }
    points[buffer](reordered)
  }

  const uploadAll = () => {
    uploadIndices()
    for (const [, buffer, data, stride] of attributes) {
      uploadAttribute(buffer, data, stride)
    }
  }

  const originalUpdatePositions = points.updatePositions
  const updatePositions = () => {
    originalUpdatePositions.call(points)
    uploadAll()
  }
  points.updatePositions = updatePositions

  const restoreAttributes = attributes.map(([update, buffer, data, stride]) => {
    const original = points[update]
    const replacement = () => {
      // In particular, updateSize also refreshes a selection texture. Let it
      // keep that texture in original-index order, then permute its display.
      original.call(points)
      uploadAttribute(buffer, data, stride)
    }
    points[update] = replacement
    return () => {
      if (points[update] === replacement) points[update] = original
    }
  })

  const originalDrawCommand = points.drawCommand
  const drawCommand = (options: DrawOptions) => {
    currentOrder()
    if (!mixed) return originalDrawCommand.call(points, options)
    // Cosmos normally draws selected nodes in a second, foreground pass.
    // Use one ordered pass so a selected empty node cannot cover a known
    // value. Selection shading and the separate hover/focus rings remain.
    if (options.skipUnselected) return
    return originalDrawCommand.call(points, {
      ...options, skipSelected: false, skipUnselected: false,
    })
  }
  points.drawCommand = drawCommand

  return {
    setEmptyIndices(indices) {
      if (disposed) return
      const count = cosmos.graph.pointsNumber
      const empty = new Uint8Array(count)
      let emptyCount = 0
      for (const index of indices) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
          throw new Error("Metadata contains an invalid network node index.")
        }
        if (!empty[index]) {
          empty[index] = 1
          emptyCount++
        }
      }
      mixed = emptyCount > 0 && emptyCount < count
      order = mixed ? new Uint32Array(count) : undefined
      if (order) {
        let emptyPosition = 0
        let knownPosition = emptyCount
        for (let index = 0; index < count; index++) {
          order[empty[index] ? emptyPosition++ : knownPosition++] = index
        }
      }
      uploadAll()
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (points.updatePositions === updatePositions) {
        points.updatePositions = originalUpdatePositions
      }
      for (const restore of restoreAttributes) restore()
      if (points.drawCommand === drawCommand) points.drawCommand = originalDrawCommand
      order = undefined
      mixed = false
      // Cosmograph may destroy the previous renderer before announcing its
      // replacement. Its buffers are no longer writable in that case.
      if (!cosmos._isDestroyed) uploadAll()
    },
  }
}
