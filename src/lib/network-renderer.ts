import type { Cosmograph } from "@cosmograph/cosmograph"
import { getInternalApi } from "@cosmograph/cosmograph/cosmograph/internal.js"

type Position = [number, number]
type CameraTransform = { x: number; y: number; k: number }

interface CosmosRenderer {
  canvas: HTMLCanvasElement
  config: { renderLinks?: boolean }
  store: { linksTextureSize: number }
  reglInstance: {
    clear(options: { color: number[]; depth: number; stencil: number }): void
  }
  lines: { draw(): void }
  points: { draw(): void }
  zoomInstance: {
    eventTransform: CameraTransform
    getTransform(positions: Position[], scale: number, padding: number): CameraTransform
    behavior: { transform: unknown }
  }
  canvasD3Selection: {
    call(callback: unknown, transform: CameraTransform): unknown
  }
  stopFrames(): void
  startFrames(): void
  resizeCanvas(): void
  screenToSpacePosition(position: Position): Position
}

export interface NetworkRenderer {
  canvas: HTMLCanvasElement
  gl: WebGLRenderingContext
  pause(): void
  resume(): void
  drawTransparent(): void
  captureCamera(): () => void
  screenToSpace(position: Position): Position
  centerOn(position: Position, zoom: number): void
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function")
}

function hasMethod(value: unknown, key: string): boolean {
  return isObject(value) && typeof value[key] === "function"
}

function isRenderer(value: unknown): value is CosmosRenderer {
  if (!isObject(value)) return false
  const zoom = value.zoomInstance
  const transform = isObject(zoom) ? zoom.eventTransform : undefined
  return value.canvas instanceof HTMLCanvasElement
    && isObject(value.config)
    && isObject(value.store)
    && typeof value.store.linksTextureSize === "number"
    && hasMethod(value.reglInstance, "clear")
    && hasMethod(value.lines, "draw")
    && hasMethod(value.points, "draw")
    && hasMethod(value.canvasD3Selection, "call")
    && hasMethod(zoom, "getTransform")
    && isObject(zoom)
    && hasMethod(zoom.behavior, "transform")
    && isObject(transform)
    && [transform.x, transform.y, transform.k].every(
      (coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate)
    )
    && ["stopFrames", "startFrames", "resizeCanvas", "screenToSpacePosition"].every(
      (method) => hasMethod(value, method)
    )
}

/**
 * Cosmograph has no public transparent render or complete camera API. Keep the
 * version-dependent bridge here, and reject incompatible renderer versions.
 */
export function getNetworkRenderer(graph: Cosmograph): NetworkRenderer {
  const cosmos: unknown = getInternalApi(graph).cosmos
  if (!isRenderer(cosmos)) {
    throw new Error("This network renderer does not support transparent image export.")
  }
  const gl = cosmos.canvas.getContext("webgl")
  if (!gl) throw new Error("The network's WebGL context is unavailable.")

  const applyCamera = (transform: CameraTransform) => {
    cosmos.canvasD3Selection.call(cosmos.zoomInstance.behavior.transform, transform)
  }

  return {
    canvas: cosmos.canvas,
    gl,
    pause: () => cosmos.stopFrames(),
    resume: () => cosmos.startFrames(),
    drawTransparent() {
      cosmos.resizeCanvas()
      // Clear only the framebuffer: changing configured background RGB also
      // changes selection greyout colours in the point shaders. Transparent
      // black is required for the canvas's premultiplied-alpha blending.
      cosmos.reglInstance.clear({ color: [0, 0, 0, 0], depth: 1, stencil: 0 })
      if (cosmos.config.renderLinks && cosmos.store.linksTextureSize) {
        cosmos.lines.draw()
      }
      cosmos.points.draw()
    },
    captureCamera() {
      const transform = cosmos.zoomInstance.eventTransform
      return () => {
        cosmos.resizeCanvas()
        applyCamera(transform)
      }
    },
    screenToSpace: (position) => cosmos.screenToSpacePosition(position),
    centerOn(position, zoom) {
      cosmos.resizeCanvas()
      // Apply immediately; Cosmos's convenience method schedules a D3
      // transition even with zero duration, which could capture the old view.
      applyCamera(cosmos.zoomInstance.getTransform([position], zoom, 0))
    },
  }
}
