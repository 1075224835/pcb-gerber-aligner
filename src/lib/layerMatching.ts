import type { GerberLayer } from '../types'

export interface LayerMatch {
  targetOrder: number | null
  matchedCopperIds: string[]
  contextLayerIds: string[]
  visibleLayerIds: string[]
  label: string
}

export function matchLayersForScan(scanName: string, layers: GerberLayer[]): LayerMatch {
  const targetOrder = inferPhysicalOrderFromScanName(scanName, layers)
  const copperLayers = layers.filter((layer) => layer.kind === 'copper')
  const matchedCopper = findCopperLayersByOrder(copperLayers, targetOrder)
  const contextLayers = layers.filter((layer) => shouldIncludeContextLayer(layer))
  const visibleLayerIds = new Set([
    ...matchedCopper.map((layer) => layer.id),
    ...contextLayers.map((layer) => layer.id),
  ])

  return {
    targetOrder,
    matchedCopperIds: matchedCopper.map((layer) => layer.id),
    contextLayerIds: contextLayers.map((layer) => layer.id),
    visibleLayerIds: Array.from(visibleLayerIds),
    label: matchedCopper.length
      ? matchedCopper.map((layer) => layer.name).join(' + ')
      : '未匹配线路层',
  }
}

export function applyScanLayerCombination(scanName: string, layers: GerberLayer[]) {
  const match = matchLayersForScan(scanName, layers)
  const visible = new Set(match.visibleLayerIds)
  return layers.map((layer) => ({
    ...layer,
    visible: visible.has(layer.id),
    opacity: match.matchedCopperIds.includes(layer.id) ? 0.9 : layer.opacity,
  }))
}

function inferPhysicalOrderFromScanName(scanName: string, layers: GerberLayer[]) {
  const name = scanName.replace(/\.[^.]+$/, '').toUpperCase()
  const copperOrders = layers
    .filter((layer) => layer.kind === 'copper' && layer.physicalOrder !== null)
    .map((layer) => layer.physicalOrder as number)
    .sort((a, b) => a - b)

  if (/^(TL|TO|TOP|TOPLAYER)$/.test(name)) return firstOrder(copperOrders, 1)
  if (/^(BL|BO|BOT|BOTTOM|BOTTOMLAYER)$/.test(name)) return lastOrder(copperOrders, 6)
  if (/^(M1|MO1|M01|MO01)$/.test(name)) return firstOrder(copperOrders, 2)
  if (/^(M2|MO2|M02|MO02)$/.test(name)) return firstOrder(copperOrders, 3)
  if (/^(M3|MO3)$/.test(name)) return firstOrder(copperOrders, 4)
  if (/^(M03|M4|M04|MO4|MO04)$/.test(name)) return firstOrder(copperOrders, 5)

  const numbered = name.match(/(?:^|[^0-9])([1-6])(?:$|[^0-9])/)
  if (numbered) {
    const number = Number(numbered[1])
    return firstOrder(copperOrders, number)
  }

  return null
}

function findCopperLayersByOrder(copperLayers: GerberLayer[], targetOrder: number | null) {
  if (targetOrder === null) return []
  const byOrder = copperLayers.filter((layer) => layer.physicalOrder === targetOrder)
  if (byOrder.length) return byOrder

  return copperLayers.filter((layer) => {
    const ext = layer.extension.toUpperCase()
    if (targetOrder === 1) return ext === '.GTL'
    if (targetOrder === 6) return ext === '.GBL'
    return ext === `.G${targetOrder - 1}`
  })
}

function shouldIncludeContextLayer(layer: GerberLayer) {
  if (layer.viewBox[2] <= 0 || layer.viewBox[3] <= 0) return false
  if (layer.kind === 'drill') return true
  if (layer.kind !== 'outline') return false
  return layer.width > 80 && layer.height > 50
}

function firstOrder(orders: number[], fallback: number) {
  return orders.includes(fallback) ? fallback : orders[0] ?? fallback
}

function lastOrder(orders: number[], fallback: number) {
  return orders.includes(fallback) ? fallback : orders.at(-1) ?? fallback
}
