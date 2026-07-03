import gerberToSvg from 'gerber-to-svg'
import type { GerberLayer, LayerKind } from '../types'

const COLOR_SEQUENCE = [
  '#34d399',
  '#38bdf8',
  '#f97316',
  '#f472b6',
  '#a78bfa',
  '#facc15',
  '#22c55e',
  '#fb7185',
]

const RENDERABLE_EXTENSIONS = new Set([
  '.gbr',
  '.gtl',
  '.gbl',
  '.gto',
  '.gbo',
  '.gts',
  '.gbs',
  '.gtp',
  '.gbp',
  '.g1',
  '.g2',
  '.g3',
  '.g4',
  '.gg1',
  '.gg2',
  '.gg3',
  '.gd1',
  '.gd2',
  '.gd3',
  '.gpt',
  '.gpb',
  '.gm',
  '.gm1',
  '.gm13',
  '.gm15',
  '.txt',
  '.drl',
  '.xln',
  '.nc',
  '.tx1',
  '.tx2',
])

export function isRenderableGerberFile(fileName: string) {
  return RENDERABLE_EXTENSIONS.has(getExtension(fileName))
}

export function getExtension(fileName: string) {
  const dot = fileName.lastIndexOf('.')
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : ''
}

export function classifyLayer(fileName: string): LayerKind {
  const ext = getExtension(fileName)
  if (['.gtl', '.gbl', '.g1', '.g2', '.g3', '.g4'].includes(ext)) return 'copper'
  if (['.gts', '.gbs'].includes(ext)) return 'mask'
  if (['.gtp', '.gbp', '.gpt', '.gpb'].includes(ext)) return 'paste'
  if (['.gto', '.gbo'].includes(ext)) return 'silkscreen'
  if (['.gm', '.gm1', '.gm13', '.gm15'].includes(ext)) return 'outline'
  if (['.txt', '.drl', '.xln', '.nc', '.tx1', '.tx2'].includes(ext)) return 'drill'
  if (ext.startsWith('.gd') || ext.startsWith('.gg')) return 'mechanical'
  return 'other'
}

export function layerKindLabel(kind: LayerKind) {
  const labels: Record<LayerKind, string> = {
    copper: '铜层',
    mask: '阻焊',
    paste: '钢网',
    silkscreen: '丝印',
    outline: '板框',
    drill: '钻孔',
    mechanical: '机械',
    other: '其他',
  }
  return labels[kind]
}

export function unionViewBox(layers: GerberLayer[]): [number, number, number, number] {
  const boxes = layers.filter((layer) => layer.viewBox[2] > 0 && layer.viewBox[3] > 0)
  if (!boxes.length) return [0, 0, 1000, 1000]

  const minX = Math.min(...boxes.map((layer) => layer.viewBox[0]))
  const minY = Math.min(...boxes.map((layer) => layer.viewBox[1]))
  const maxX = Math.max(...boxes.map((layer) => layer.viewBox[0] + layer.viewBox[2]))
  const maxY = Math.max(...boxes.map((layer) => layer.viewBox[1] + layer.viewBox[3]))
  return [minX, minY, maxX - minX, maxY - minY]
}

export function boardSizeMm(viewBox: [number, number, number, number]) {
  return {
    width: viewBox[2] / 1000,
    height: viewBox[3] / 1000,
  }
}

export function convertGerberFile(file: File, index: number): Promise<GerberLayer> {
  return file.text().then((text) => convertGerberText(file.name, text, index))
}

export function convertGerberText(
  fileName: string,
  text: string,
  index: number,
): Promise<GerberLayer> {
  const id = `layer-${index}-${slugify(fileName)}`
  const warnings: string[] = []

  return new Promise((resolve, reject) => {
    const converter = gerberToSvg(
      text,
      {
        id,
        optimizePaths: true,
        attributes: {
          color: 'currentColor',
        },
      },
      (error, svg) => {
        if (error) {
          reject(error)
          return
        }

        const viewBox = normalizeViewBox(converter.viewBox)
        resolve({
          id,
          name: fileName,
          extension: getExtension(fileName),
          kind: classifyLayer(fileName),
          svg,
          svgBody: extractSvgBody(svg),
          viewBox,
          width: converter.width,
          height: converter.height,
          units: converter.units,
          physicalOrder: extractPhysicalOrder(text),
          color: COLOR_SEQUENCE[index % COLOR_SEQUENCE.length],
          opacity: 0.85,
          visible: ['copper', 'outline', 'drill'].includes(classifyLayer(fileName)),
          warnings,
        })
      },
    )

    converter.on('warning', (warning: { message: string; line?: number }) => {
      warnings.push(
        typeof warning.line === 'number'
          ? `L${warning.line}: ${warning.message}`
          : warning.message,
      )
    })
  })
}

function normalizeViewBox(viewBox: number[]): [number, number, number, number] {
  if (viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value))) {
    return [0, 0, 0, 0]
  }
  return [viewBox[0], viewBox[1], viewBox[2], viewBox[3]]
}

function extractPhysicalOrder(text: string) {
  const match = text.match(/Layer_Physical_Order=(\d+)/i)
  return match ? Number(match[1]) : null
}

function extractSvgBody(svg: string) {
  return svg
    .replace(/^[\s\S]*?<svg\b[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '')
    .trim()
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}
