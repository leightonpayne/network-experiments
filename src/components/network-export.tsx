import * as React from "react"
import * as Dialog from "@radix-ui/react-dialog"
import type { CosmographRef } from "@cosmograph/react"
import { ChevronDown, Download, LoaderCircle } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { exportNetworkPng } from "@/lib/export-network"

interface NetworkExportProps {
  graphRef: React.RefObject<CosmographRef | null>
  viewportRef: React.RefObject<HTMLDivElement | null>
  ready: boolean
  colorBy?: string
}

interface ExportRequest {
  graph: NonNullable<CosmographRef>
  viewport: HTMLDivElement
  resolution: 4096 | 8192 | 12288
  colorBy?: string
}

export function NetworkExport({
  graphRef,
  viewportRef,
  ready,
  colorBy,
}: NetworkExportProps) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [request, setRequest] = React.useState<ExportRequest | null>(null)
  const busyRef = React.useRef(false)
  const buttonRef = React.useRef<HTMLButtonElement>(null)

  const beginExport = (resolution: ExportRequest["resolution"]) => {
    if (!ready || busyRef.current) return
    const graph = graphRef.current
    const viewport = viewportRef.current
    if (!graph || !viewport) {
      toast.error("The network is not ready to export yet.")
      return
    }
    busyRef.current = true
    setMenuOpen(false)
    setRequest({ graph, viewport, resolution, colorBy })
  }

  React.useEffect(() => {
    if (!request) return
    let cancelled = false
    // Let the menu close and the blocking dialog paint before capture begins.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (cancelled) return
        void (async () => {
          try {
            const { width, height } = await exportNetworkPng(
              request.graph,
              request.viewport,
              request.resolution,
              request.colorBy
            )
            toast.success("PNG exported", {
              description: `${width.toLocaleString()} × ${height.toLocaleString()} pixels`,
            })
          } catch (error) {
            toast.error("Could not export the network", {
              description:
                error instanceof Error ? error.message : "Please try again.",
            })
          } finally {
            busyRef.current = false
            if (!cancelled) setRequest(null)
          }
        })()
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [request])

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            ref={buttonRef}
            variant="outline"
            size="sm"
            aria-label="Export PNG"
            disabled={!ready || request !== null}
          >
            <Download aria-hidden="true" />
            <span className="hidden sm:inline">Export PNG</span>
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-64"
          onCloseAutoFocus={(event) => {
            if (busyRef.current) event.preventDefault()
          }}
        >
          <DropdownMenuLabel>Longest edge</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => beginExport(4096)}>
            4,096 px
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => beginExport(8192)}>
            8,192 px
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => beginExport(12288)}>
            12,288 px
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            Transparent background. Network only, cropped to visible nodes and
            links.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog.Root open={request !== null}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <Dialog.Content
            className="fixed top-1/2 left-1/2 z-50 w-[calc(100%_-_2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-6 text-foreground shadow-lg outline-none"
            onEscapeKeyDown={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              buttonRef.current?.focus()
            }}
          >
            <Dialog.Title className="flex items-center gap-2 font-semibold">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              Exporting network
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted-foreground">
              Rendering the network at up to {request?.resolution.toLocaleString()}{" "}
              pixels. This may take a moment.
            </Dialog.Description>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
