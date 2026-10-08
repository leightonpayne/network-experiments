import type { CosmographRef } from "@cosmograph/react"
import { getNetworkRenderer } from "./network-renderer.ts"
import { waitForMetadataLayering } from "./metadata-layering.ts"

const MAX_RENDER_PIXELS = 180_000_000
const MAX_RENDER_DIMENSION = 16_384

export interface NetworkBounds {
  x: number
  y: number
  width: number
  height: number
}

/** WebGL rows run bottom to top; return a crop in CSS/top-left coordinates. */
export function getNetworkBounds(pixels: Uint8Array, width: number, height: number): NetworkBounds | null {
  let left = width
  let right = -1
  let bottom = height
  let top = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] === 0) continue
      left = Math.min(left, x)
      right = Math.max(right, x)
      bottom = Math.min(bottom, y)
      top = Math.max(top, y)
    }
  }
  if (right < left) return null
  // Leave a small transparent margin, including antialiasing at higher resolution.
  left = Math.max(0, left - 2)
  right = Math.min(width - 1, right + 2)
  bottom = Math.max(0, bottom - 2)
  top = Math.min(height - 1, top + 2)
  return { x: left, y: height - 1 - top, width: right - left + 1, height: top - bottom + 1 }
}

function nextFrame() {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cancelAnimationFrame(frame)
      reject(new Error("Keep this tab visible while exporting, then try again."))
    }, 10_000)
    const frame = requestAnimationFrame(() => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

function pngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob?.size) resolve(blob)
      else reject(new Error("The browser could not create the image. Try a smaller image size."))
    }, "image/png")
  })
}

/** Render the visible network itself to a cropped, transparent, high-resolution PNG. */
export async function exportNetworkPng(
  graph: NonNullable<CosmographRef>,
  viewport: HTMLElement,
  resolution: 4096 | 8192 | 12288,
  colorBy?: string
): Promise<{ width: number; height: number }> {
  if (![4096, 8192, 12288].includes(resolution)) throw new Error("Unsupported image size.")
  if (!viewport.isConnected || !viewport.offsetWidth || !viewport.offsetHeight || !graph.stats.pointsCount) {
    throw new Error("Wait for the network to finish loading, then try again.")
  }
  await waitForMetadataLayering(graph)
  const renderer = getNetworkRenderer(graph)
  const { canvas, gl } = renderer
  if (gl.isContextLost()) throw new Error("The graphics context was lost. Reload the page and try again.")
  const viewportLimit = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
  const dimensionLimit = Math.min(
    MAX_RENDER_DIMENSION,
    gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
    gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    viewportLimit[0],
    viewportLimit[1]
  )

  const original = await graph.getConfig()
  const originalStyle = viewport.style.cssText
  const windowSize = [window.innerWidth, window.innerHeight]
  const borderWidth = viewport.offsetWidth - canvas.clientWidth
  const borderHeight = viewport.offsetHeight - canvas.clientHeight
  const restoreCamera = renderer.captureCamera()
  const zoom = graph.getZoomLevel() ?? 1
  let output: HTMLCanvasElement | undefined
  let native: HTMLCanvasElement | undefined
  let blob: Blob
  let width = 0
  let height = 0

  renderer.pause()
  try {
    // Find the bounds from a small transparent render of the current visible view.
    // This respects hidden nodes, selections and links without copying the DOM.
    await graph.setConfig({ ...original, pixelRatio: 1 })
    renderer.pause()
    renderer.drawTransparent()
    if (gl.isContextLost() || gl.drawingBufferWidth !== canvas.clientWidth || gl.drawingBufferHeight !== canvas.clientHeight) {
      throw new Error("The browser could not render the network. Reload the page and try again.")
    }
    const pixels = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    const bounds = getNetworkBounds(pixels, canvas.width, canvas.height)
    if (!bounds) throw new Error("No network is visible. Adjust the view or filters and try again.")
    const origin = renderer.screenToSpace([0, 0])
    const unitX = renderer.screenToSpace([1, 0])
    const unitY = renderer.screenToSpace([0, 1])
    const toSpace = (x: number, y: number): [number, number] => [
      origin[0] + x * (unitX[0] - origin[0]) + y * (unitY[0] - origin[0]),
      origin[1] + x * (unitX[1] - origin[1]) + y * (unitY[1] - origin[1]),
    ]
    const longestEdge = Math.max(bounds.width, bounds.height)
    const ratio = Math.ceil(resolution / longestEdge)
    const renderWidth = bounds.width * ratio
    const renderHeight = bounds.height * ratio
    if (renderWidth > MAX_RENDER_DIMENSION || renderHeight > MAX_RENDER_DIMENSION || renderWidth * renderHeight > MAX_RENDER_PIXELS) {
      throw new Error("This view is too large to render at that size. Choose a smaller image size.")
    }

    // A GPU point-size limit must not silently make exported nodes smaller.
    const pointLimit = (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array)[1]
    let largestPoint = original.pointDefaultSize ?? 4
    for (const size of graph.getPointSizes() ?? []) largestPoint = Math.max(largestPoint, size)
    const zoomScale = original.scalePointsOnZoom ? zoom : Math.min(5, Math.max(1, zoom * 0.01))
    const screenPointSize = Math.min(
      largestPoint * (original.pointSizeScale ?? 1) * zoomScale,
      pointLimit / (original.pixelRatio ?? 1)
    )
    if (screenPointSize * ratio > pointLimit) {
      throw new Error("The nodes are too large for this image size. Reduce node size or choose a smaller image size.")
    }

    // Render overlapping tiles to avoid browser drawing-buffer limits. Keep
    // integer source pixels throughout assembly so adjacent tiles cannot leave seams.
    native = document.createElement("canvas")
    native.width = renderWidth
    native.height = renderHeight
    const nativeContext = native.getContext("2d")
    if (!nativeContext) throw new Error("The browser could not allocate the image. Try a smaller image size.")
    const padding = Math.ceil(screenPointSize / 2) + 2
    const tileSize = Math.floor(Math.min(2048, dimensionLimit) / ratio) - 2 * padding
    if (tileSize < 1) throw new Error("This image size exceeds your graphics limit. Choose a smaller image size.")
    viewport.style.flex = "none"
    // Resize before raising the pixel ratio to avoid a large intermediate GPU buffer.
    viewport.style.width = `${Math.min(tileSize, bounds.width) + 2 * padding + borderWidth}px`
    viewport.style.height = `${Math.min(tileSize, bounds.height) + 2 * padding + borderHeight}px`
    await graph.setConfig({ ...original, pixelRatio: ratio })
    renderer.pause()
    for (let y = 0; y < bounds.height; y += tileSize) {
      for (let x = 0; x < bounds.width; x += tileSize) {
        const tileWidth = Math.min(tileSize, bounds.width - x)
        const tileHeight = Math.min(tileSize, bounds.height - y)
        viewport.style.width = `${tileWidth + 2 * padding + borderWidth}px`
        viewport.style.height = `${tileHeight + 2 * padding + borderHeight}px`
        renderer.centerOn(toSpace(bounds.x + x + tileWidth / 2, bounds.y + y + tileHeight / 2), zoom)
        renderer.drawTransparent()
        const expectedWidth = (tileWidth + 2 * padding) * ratio
        const expectedHeight = (tileHeight + 2 * padding) * ratio
        if (
          gl.isContextLost() || canvas.width !== expectedWidth || canvas.height !== expectedHeight ||
          gl.drawingBufferWidth !== expectedWidth || gl.drawingBufferHeight !== expectedHeight
        ) {
          throw new Error("The browser could not render this image size. Try a smaller image size.")
        }
        nativeContext.drawImage(
          canvas, padding * ratio, padding * ratio, tileWidth * ratio, tileHeight * ratio,
          x * ratio, y * ratio, tileWidth * ratio, tileHeight * ratio
        )
      }
      await nextFrame()
      if (window.innerWidth !== windowSize[0] || window.innerHeight !== windowSize[1]) {
        throw new Error("The window changed size during export. Keep it at the same size and try again.")
      }
    }

    width = Math.max(1, Math.round(resolution * bounds.width / longestEdge))
    height = Math.max(1, Math.round(resolution * bounds.height / longestEdge))
    output = document.createElement("canvas")
    output.width = width
    output.height = height
    const context = output.getContext("2d")
    if (!context) throw new Error("The browser could not allocate the image. Try a smaller image size.")
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = "high"
    // Canvas copying correctly converts premultiplied alpha. Only downsample
    // the assembled native render; never enlarge a lower-resolution screenshot.
    context.drawImage(native, 0, 0, width, height)
    native.width = 0
    native.height = 0
    blob = await pngBlob(output)
  } finally {
    if (output) { output.width = 0; output.height = 0 }
    if (native) { native.width = 0; native.height = 0 }
    viewport.style.cssText = originalStyle
    try {
      await graph.setConfig(original)
      restoreCamera()
    } finally {
      renderer.resume()
    }
    await nextFrame()
    await nextFrame()
  }

  if (window.innerWidth !== windowSize[0] || window.innerHeight !== windowSize[1]) {
    throw new Error("The window changed size during export. Keep it at the same size and try again.")
  }
  const attribute = (colorBy || "network").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80)
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = `plasmid-${attribute}-transparent-${width}x${height}.png`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return { width, height }
}
