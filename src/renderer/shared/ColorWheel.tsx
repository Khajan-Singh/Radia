import { useCallback, useEffect, useRef, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { ColorOverride } from '../../shared/types'

interface Props {
  value: ColorOverride
  onChange: (next: ColorOverride) => void
  size?: number
  label: string
}

/**
 * HSV disc: hue around the circle, saturation from center to edge. Value lives
 * on the separate brightness slider beside it, but is baked into the disc's
 * rendering so a dark color shows a dark wheel - which is how the reference UI
 * distinguishes the two wheels at a glance.
 */
export function ColorWheel({ value, onChange, size = 150, label }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragging = useRef(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = size * dpr
    canvas.height = size * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const image = ctx.createImageData(canvas.width, canvas.height)
    const radius = canvas.width / 2

    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const dx = x - radius + 0.5
        const dy = y - radius + 0.5
        const dist = Math.hypot(dx, dy)
        const o = (y * canvas.width + x) * 4

        if (dist > radius) {
          image.data[o + 3] = 0
          continue
        }

        const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360 + 90) % 360
        const sat = Math.min(1, dist / radius)
        const [r, g, b] = hsvToRgb(hue, sat, value.v)

        image.data[o] = r * 255
        image.data[o + 1] = g * 255
        image.data[o + 2] = b * 255
        // Feather the outer pixel ring so the disc edge isn't jagged.
        image.data[o + 3] = 255 * Math.min(1, (radius - dist) / (dpr * 1.2))
      }
    }
    ctx.putImageData(image, 0, 0)
  }, [size, value.v])

  const pick = useCallback(
    (clientX: number, clientY: number): void => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const dx = clientX - rect.left - rect.width / 2
      const dy = clientY - rect.top - rect.height / 2
      const radius = rect.width / 2
      const dist = Math.hypot(dx, dy)
      const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360 + 90) % 360
      onChange({ ...value, h: hue, s: Math.min(1, dist / radius) })
    },
    [onChange, value]
  )

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    pick(e.clientX, e.clientY)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (dragging.current) pick(e.clientX, e.clientY)
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    dragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  // Handle position, with hue measured from the top to match the disc drawing.
  const angle = ((value.h - 90) * Math.PI) / 180
  const handleX = size / 2 + Math.cos(angle) * (value.s * size) / 2
  const handleY = size / 2 + Math.sin(angle) * (value.s * size) / 2

  return (
    <div className="wheel" style={{ width: size, height: size }}>
      <canvas
        ref={canvasRef}
        style={{ width: size, height: size }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="slider"
        aria-label={label}
        aria-valuetext={`hue ${Math.round(value.h)} degrees, saturation ${Math.round(value.s * 100)}%`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') onChange({ ...value, h: (value.h + 355) % 360 })
          else if (e.key === 'ArrowRight') onChange({ ...value, h: (value.h + 5) % 360 })
          else if (e.key === 'ArrowUp') onChange({ ...value, s: Math.min(1, value.s + 0.04) })
          else if (e.key === 'ArrowDown') onChange({ ...value, s: Math.max(0, value.s - 0.04) })
          else return
          e.preventDefault()
        }}
      />
      <span className="wheel-handle" style={{ left: handleX, top: handleY }} />
    </div>
  )
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s
  const hh = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const m = v - c
  const table: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x]
  ]
  const seg = table[Math.floor(hh) % 6]
  return [seg[0] + m, seg[1] + m, seg[2] + m]
}

export function cssColor(c: ColorOverride): string {
  const [r, g, b] = hsvToRgb(c.h, c.s, c.v)
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`
}
