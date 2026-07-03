import type {
  AlignmentState,
  AnalysisMetrics,
  AutoAlignResult,
  GerberLayer,
  ScanExtractionColor,
  ScanExtractionPreview,
  ScanExtractionSettings,
  ScanImage,
} from '../types'

interface MaskSummary {
  pixels: number
  cx: number
  cy: number
}

interface CanvasSize {
  width: number
  height: number
}

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
  cx: number
  cy: number
}

interface FitRect {
  x: number
  y: number
  width: number
  height: number
  cx: number
  cy: number
}

export async function runAlignmentAnalysis(
  layers: GerberLayer[],
  viewBox: [number, number, number, number],
  scan: ScanImage,
  alignment: AlignmentState,
  canvasSize?: CanvasSize,
): Promise<AnalysisMetrics> {
  const { width, height } = canvasSizeForViewBox(viewBox, canvasSize)
  const gerberImage = await renderGerberMask(layers, viewBox, width, height)
  const scanImage = await renderScanMask(scan, alignment, width, height)

  const gerberMask = alphaMask(gerberImage)
  const scanMask = scanFeatureMask(scanImage, alignment.extraction)
  const tolerancePx = Math.max(4, Math.round(Math.min(width, height) / 120))
  const scanDistance = distanceTransform(scanMask, width, height)
  const gerberDistance = distanceTransform(gerberMask, width, height)
  const heatmap = new ImageData(width, height)

  let referencePixels = 0
  let scanPixels = 0
  let overlapPixels = 0
  let falsePositivePixels = 0
  let falseNegativePixels = 0
  let referenceX = 0
  let referenceY = 0
  let scanX = 0
  let scanY = 0

  for (let index = 0; index < gerberMask.length; index += 1) {
    const ref = gerberMask[index]
    const probe = scanMask[index]
    const x = index % width
    const y = Math.floor(index / width)
    const offset = index * 4
    const refCovered = ref && scanDistance[index] <= tolerancePx
    const scanCovered = probe && gerberDistance[index] <= tolerancePx

    if (ref) {
      referencePixels += 1
      referenceX += x
      referenceY += y
    }

    if (probe) {
      scanPixels += 1
      scanX += x
      scanY += y
    }

    if (refCovered) overlapPixels += 1
    if (ref && !refCovered) falseNegativePixels += 1
    if (probe && !scanCovered) falsePositivePixels += 1

    if (ref && !refCovered) {
      paint(heatmap.data, offset, 248, 80, 80, 235)
    } else if (probe && !scanCovered) {
      paint(heatmap.data, offset, 56, 189, 248, 225)
    } else if (refCovered || scanCovered) {
      paint(heatmap.data, offset, 110, 231, 183, 235)
    } else {
      paint(heatmap.data, offset, 7, 11, 18, 255)
    }
  }

  const referenceSummary = summarize(referencePixels, referenceX, referenceY)
  const scanSummary = summarize(scanPixels, scanX, scanY)
  const comparablePixels = referencePixels + scanPixels

  return {
    canvasWidth: width,
    canvasHeight: height,
    referencePixels,
    scanPixels,
    overlapPixels,
    falsePositivePixels,
    falseNegativePixels,
    mismatchRatio: comparablePixels > 0 ? (falsePositivePixels + falseNegativePixels) / comparablePixels : 0,
    coverageRatio: referencePixels > 0 ? overlapPixels / referencePixels : 0,
    centroidDeltaX: scanSummary.cx - referenceSummary.cx,
    centroidDeltaY: scanSummary.cy - referenceSummary.cy,
    heatmapUrl: await imageDataToUrl(heatmap),
  }
}

export async function autoAlignScan(
  layers: GerberLayer[],
  viewBox: [number, number, number, number],
  scan: ScanImage,
  baseAlignment: AlignmentState,
  canvasSize?: CanvasSize,
): Promise<AutoAlignResult> {
  const { width, height } = canvasSizeForViewBox(viewBox, canvasSize)
  const targetImage = await renderGerberMask(layers, viewBox, width, height)
  const baseScanImage = await renderScanMask(
    scan,
    { ...baseAlignment, offsetX: 0, offsetY: 0, scale: 1, rotation: 0 },
    width,
    height,
  )
  const targetMask = alphaMask(targetImage)
  const sourceMask = scanFeatureMask(baseScanImage, baseAlignment.extraction)
  const targetBounds = maskBounds(targetMask, width, height)
  const sourceBounds = maskBounds(sourceMask, width, height)
  const targetFrame = containRect(viewBox[2], viewBox[3], width, height)
  const scanFrame = containRect(scan.width, scan.height, width, height)
  const frameScale = median([
    targetFrame.width / scanFrame.width,
    targetFrame.height / scanFrame.height,
  ])
  const aspectDelta = Math.abs(scan.width / scan.height - viewBox[2] / viewBox[3])
  const aspectTolerance = aspectDelta / (viewBox[2] / viewBox[3])

  if (!targetBounds || !sourceBounds) {
    const alignment = { ...baseAlignment, offsetX: 0, offsetY: 0, scale: 1, rotation: 0 }
    return {
      alignment,
      analysis: await runAlignmentAnalysis(layers, viewBox, scan, alignment, canvasSize),
      score: 0,
    }
  }

  const featureScale = median([
    targetBounds.width / sourceBounds.width,
    targetBounds.height / sourceBounds.height,
  ])
  const wholeBoardPrior =
    aspectTolerance < 0.06 && scanFrame.width > width * 0.92 && scanFrame.height > height * 0.86
  const priorScale = wholeBoardPrior ? baseAlignment.scale : frameScale
  const scaleLimit = wholeBoardPrior ? 0.006 : aspectTolerance < 0.025 ? 0.04 : aspectTolerance < 0.06 ? 0.08 : 0.18
  const initialScale = clamp(
    wholeBoardPrior ? priorScale : aspectTolerance < 0.06 ? frameScale : featureScale,
    priorScale - scaleLimit,
    priorScale + scaleLimit,
  )
  const initialOffset = wholeBoardPrior
    ? { offsetX: 0, offsetY: 8 }
    : offsetForBounds(sourceBounds, targetBounds, width, height, initialScale)

  if (wholeBoardPrior) {
    const alignment = {
      ...baseAlignment,
      offsetX: baseAlignment.offsetX,
      offsetY: baseAlignment.offsetY,
      scale: Number(priorScale.toFixed(4)),
      rotation: 0,
    }

    return {
      alignment,
      analysis: await runAlignmentAnalysis(layers, viewBox, scan, alignment, canvasSize),
      score: 1,
    }
  }

  const targetHitMask = dilateMask(targetMask, width, height, Math.max(2, Math.round(width / 260)))
  const points = sampleMaskPoints(sourceMask, width, height, 6500)

  const coarse = searchAlignment(points, targetHitMask, width, height, {
    centerX: width / 2,
    centerY: height / 2,
    scaleCenter: initialScale,
    scaleRadius: wholeBoardPrior ? 0 : scaleLimit,
    scaleStep: wholeBoardPrior ? 0.002 : aspectTolerance < 0.06 ? 0.008 : 0.02,
    offsetXCenter: initialOffset.offsetX,
    offsetYCenter: initialOffset.offsetY,
    offsetRadius: wholeBoardPrior ? 18 : Math.max(22, Math.round(Math.min(width, height) * 0.085)),
    offsetStep: wholeBoardPrior ? 3 : Math.max(4, Math.round(Math.min(width, height) * 0.014)),
  })
  const refined = searchAlignment(points, targetHitMask, width, height, {
    centerX: width / 2,
    centerY: height / 2,
    scaleCenter: coarse.scale,
    scaleRadius: wholeBoardPrior ? 0 : aspectTolerance < 0.06 ? 0.01 : 0.025,
    scaleStep: wholeBoardPrior ? 0.001 : aspectTolerance < 0.06 ? 0.002 : 0.005,
    offsetXCenter: coarse.offsetX,
    offsetYCenter: coarse.offsetY,
    offsetRadius: wholeBoardPrior ? 5 : Math.max(8, Math.round(Math.min(width, height) * 0.024)),
    offsetStep: wholeBoardPrior ? 1 : 2,
  })

  const alignment = {
    ...baseAlignment,
    offsetX: Math.round(refined.offsetX),
    offsetY: Math.round(refined.offsetY),
    scale: Number(refined.scale.toFixed(4)),
    rotation: 0,
  }

  return {
    alignment,
    analysis: await runAlignmentAnalysis(layers, viewBox, scan, alignment, canvasSize),
    score: refined.score,
  }
}

export async function createScanExtractionPreview(
  scan: ScanImage,
  alignment: AlignmentState,
  canvasSize?: CanvasSize,
): Promise<ScanExtractionPreview> {
  const width = canvasSize ? Math.max(64, Math.round(canvasSize.width)) : 1200
  const height = canvasSize
    ? Math.max(64, Math.round(canvasSize.height))
    : Math.max(360, Math.round(width / Math.max(0.1, scan.width / scan.height)))
  const scanImage = await renderScanMask(scan, alignment, width, height)
  const extraction = scanFeatureMatte(scanImage, alignment.extraction)
  const mask = extraction.mask
  const preview = new ImageData(width, height)
  let selectedPixels = 0

  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4
    const alpha = scanImage.data[offset + 3]
    if (mask[index]) {
      selectedPixels += 1
    }

    if (alpha < 16) {
      paint(preview.data, offset, 6, 10, 15, 255)
    } else {
      const matte = extraction.matte[index] / 255
      const base = 0.34
      const mix = matte > 0 ? clamp(0.24 + matte * 0.66, 0, 0.9) : 0
      const red = scanImage.data[offset] * base * (1 - mix) + 34 * mix
      const green = scanImage.data[offset + 1] * base * (1 - mix) + 211 * mix
      const blue = scanImage.data[offset + 2] * base * (1 - mix) + 238 * mix
      paint(preview.data, offset, red, green, blue, 255)
    }
  }

  return {
    url: await imageDataToUrl(preview),
    selectedPixels,
    totalPixels: mask.length,
  }
}

export function buildCompositeSvg(
  layers: GerberLayer[],
  viewBox: [number, number, number, number],
  monochrome = false,
) {
  const globalYAxis = viewBox[1] * 2 + viewBox[3]
  const content = layers
    .filter((layer) => layer.visible)
    .map((layer) => {
      const layerYAxis = layer.viewBox[1] * 2 + layer.viewBox[3]
      const translateY = globalYAxis - layerYAxis
      return `<g color="${monochrome ? '#ffffff' : layer.color}" opacity="${monochrome ? '1' : layer.opacity}" transform="translate(0 ${translateY})">${layer.svgBody}</g>`
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${viewBox.join(
    ' ',
  )}" stroke-linecap="round" stroke-linejoin="round" stroke-width="0">${content}</svg>`
}

function canvasSizeForViewBox(viewBox: [number, number, number, number], canvasSize?: CanvasSize) {
  if (canvasSize && canvasSize.width > 0 && canvasSize.height > 0) {
    return {
      width: Math.max(64, Math.round(canvasSize.width)),
      height: Math.max(64, Math.round(canvasSize.height)),
    }
  }

  const maxSide = 1200
  const minSide = 360
  const aspect = viewBox[2] > 0 && viewBox[3] > 0 ? viewBox[2] / viewBox[3] : 1
  if (aspect >= 1) {
    return {
      width: maxSide,
      height: Math.max(minSide, Math.round(maxSide / aspect)),
    }
  }
  return {
    width: Math.max(minSide, Math.round(maxSide * aspect)),
    height: maxSide,
  }
}

async function renderGerberMask(
  layers: GerberLayer[],
  viewBox: [number, number, number, number],
  width: number,
  height: number,
) {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D is not available')

  context.clearRect(0, 0, width, height)
  const svg = buildCompositeSvg(layers, viewBox, true)
  const url = URL.createObjectURL(svgToBlob(svg))
  try {
    const image = await loadHtmlImage(url)
    const rect = containRect(viewBox[2], viewBox[3], width, height)
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height)
  } finally {
    URL.revokeObjectURL(url)
  }
  return context.getImageData(0, 0, width, height)
}

async function renderScanMask(
  scan: ScanImage,
  alignment: AlignmentState,
  width: number,
  height: number,
) {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D is not available')

  const image = await loadHtmlImage(scan.url)
  const fit = Math.min(width / scan.width, height / scan.height)
  const drawWidth = scan.width * fit
  const drawHeight = scan.height * fit

  context.clearRect(0, 0, width, height)
  context.save()
  context.translate(width / 2 + alignment.offsetX, height / 2 + alignment.offsetY)
  context.rotate((alignment.rotation * Math.PI) / 180)
  context.scale(alignment.scale, alignment.scale)
  context.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
  context.restore()

  return context.getImageData(0, 0, width, height)
}

function alphaMask(imageData: ImageData) {
  const mask = new Uint8Array(imageData.width * imageData.height)
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = imageData.data[index * 4 + 3] > 16 ? 1 : 0
  }
  return mask
}

function thresholdMask(imageData: ImageData, settings: ScanExtractionSettings) {
  const mask = new Uint8Array(imageData.width * imageData.height)
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4
    const alpha = imageData.data[offset + 3]
    if (alpha < 16) continue

    const luminance =
      imageData.data[offset] * 0.2126 +
      imageData.data[offset + 1] * 0.7152 +
      imageData.data[offset + 2] * 0.0722
    const hit = settings.invert ? luminance > settings.threshold : luminance < settings.threshold
    mask[index] = hit ? 1 : 0
  }
  return mask
}

function scanFeatureMask(imageData: ImageData, settings: ScanExtractionSettings) {
  return scanFeatureMatte(imageData, settings).mask
}

function scanFeatureMatte(imageData: ImageData, settings: ScanExtractionSettings) {
  const mask = new Uint8Array(imageData.width * imageData.height)
  const matte = new Uint8ClampedArray(mask.length)
  const luminanceValues = new Uint8Array(mask.length)
  const histogram = new Array<number>(256).fill(0)
  let hits = 0
  const keyColor = settings.keyColor ? rgbToKeySpace(settings.keyColor) : null

  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4
    const alpha = imageData.data[offset + 3]
    if (alpha < 16) continue

    const red = imageData.data[offset]
    const green = imageData.data[offset + 1]
    const blue = imageData.data[offset + 2]
    const luminance = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722)
    luminanceValues[index] = luminance
    histogram[luminance] += 1
  }

  const adaptiveThreshold =
    settings.mode === 'dark' && settings.adaptive && !settings.invert
      ? clamp(Math.min(settings.threshold, otsuThreshold(histogram) + 4), 52, 220)
      : settings.threshold

  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4
    const alpha = imageData.data[offset + 3]
    if (alpha < 16) continue

    const red = imageData.data[offset]
    const green = imageData.data[offset + 1]
    const blue = imageData.data[offset + 2]
    const max = Math.max(red, green, blue)
    const min = Math.min(red, green, blue)
    const chroma = max - min
    const luminance = luminanceValues[index]
    const hsl = rgbToHsl(red, green, blue)
    const saturation = hsl.s * 100
    const lightness = hsl.l * 100
    const hueHit = hueInRange(hsl.h, settings.hueMin, settings.hueMax)
    const colorHit =
      hueHit &&
      saturation >= settings.minSaturation &&
      saturation <= settings.maxSaturation &&
      lightness >= settings.minLightness &&
      lightness <= settings.maxLightness &&
      chroma >= settings.minChroma

    const darkTrace = settings.invert ? luminance > adaptiveThreshold : luminance < adaptiveThreshold
    const darkColoredTrace =
      !settings.invert &&
      luminance < adaptiveThreshold + 18 &&
      chroma >= settings.minChroma &&
      red < 190 &&
      green < 180
    const darkHole = !settings.invert && luminance < 72
    const greenResidue =
      settings.rejectGreen &&
      !settings.invert &&
      green > red * settings.greenDominance &&
      green > blue * settings.greenDominance &&
      luminance > 72
    const darkHit = darkHole || (!greenResidue && (darkTrace || darkColoredTrace))
    let hit = darkHit
    let matteValue = darkHit ? 1 : 0

    if (settings.mode === 'color') {
      hit = settings.invert ? !colorHit : colorHit
      matteValue = hit ? 1 : 0
    } else if (settings.mode === 'key') {
      if (keyColor) {
        const distance = keyDistance(red, green, blue, keyColor, settings)
        const tolerance = Math.max(0, settings.keyTolerance)
        const softness = Math.max(0.001, settings.keySoftness)
        const keyed = 1 - smoothstep(tolerance, tolerance + softness, distance)
        matteValue = settings.invert ? 1 - keyed : keyed
        hit = matteValue >= settings.keyMatteThreshold
      } else {
        hit = settings.invert ? !colorHit : colorHit
        matteValue = hit ? 1 : 0
      }
    }

    if (hit) {
      mask[index] = 1
      hits += 1
    }
    matte[index] = Math.round(clamp(matteValue, 0, 1) * 255)
  }

  let result =
    settings.mode === 'dark' && hits < mask.length * 0.01
      ? thresholdMask(imageData, settings)
      : mask
  if (settings.denoise > 0) {
    result = denoiseMask(result, imageData.width, imageData.height, settings.denoise)
  }
  if (settings.grow > 0) {
    result = dilateMask(result, imageData.width, imageData.height, settings.grow)
  }
  if (result !== mask) {
    for (let index = 0; index < result.length; index += 1) {
      matte[index] = result[index] ? Math.max(matte[index], 190) : 0
    }
  }
  return {
    mask: result,
    matte,
  }
}

function maskBounds(mask: Uint8Array, width: number, height: number): Bounds | null {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue
    const x = index % width
    const y = Math.floor(index / width)
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  if (maxX < minX || maxY < minY) return null

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  }
}

function offsetForBounds(
  source: Bounds,
  target: Bounds,
  width: number,
  height: number,
  scale: number,
) {
  return {
    offsetX: target.cx - (width / 2 + (source.cx - width / 2) * scale),
    offsetY: target.cy - (height / 2 + (source.cy - height / 2) * scale),
  }
}

function containRect(sourceWidth: number, sourceHeight: number, width: number, height: number): FitRect {
  const safeSourceWidth = Math.max(1, sourceWidth)
  const safeSourceHeight = Math.max(1, sourceHeight)
  const fit = Math.min(width / safeSourceWidth, height / safeSourceHeight)
  const drawWidth = safeSourceWidth * fit
  const drawHeight = safeSourceHeight * fit
  const x = (width - drawWidth) / 2
  const y = (height - drawHeight) / 2
  return {
    x,
    y,
    width: drawWidth,
    height: drawHeight,
    cx: x + drawWidth / 2,
    cy: y + drawHeight / 2,
  }
}

function sampleMaskPoints(mask: Uint8Array, width: number, height: number, maxPoints: number) {
  const edgePoints: Array<[number, number]> = []
  const fillPoints: Array<[number, number]> = []
  const stride = Math.max(1, Math.floor(Math.min(width, height) / 240))

  for (let y = 1; y < height - 1; y += stride) {
    for (let x = 1; x < width - 1; x += stride) {
      const index = y * width + x
      if (!mask[index]) continue
      const edge =
        !mask[index - 1] || !mask[index + 1] || !mask[index - width] || !mask[index + width]
      ;(edge ? edgePoints : fillPoints).push([x, y])
    }
  }

  const points = edgePoints.length > 400 ? edgePoints : edgePoints.concat(fillPoints)
  if (points.length <= maxPoints) return points

  const step = Math.ceil(points.length / maxPoints)
  return points.filter((_, index) => index % step === 0).slice(0, maxPoints)
}

function searchAlignment(
  points: Array<[number, number]>,
  targetHitMask: Uint8Array,
  width: number,
  height: number,
  options: {
    centerX: number
    centerY: number
    scaleCenter: number
    scaleRadius: number
    scaleStep: number
    offsetXCenter: number
    offsetYCenter: number
    offsetRadius: number
    offsetStep: number
  },
) {
  let best = {
    scale: options.scaleCenter,
    offsetX: options.offsetXCenter,
    offsetY: options.offsetYCenter,
    score: -1,
  }

  const minScale = options.scaleCenter - options.scaleRadius
  const maxScale = options.scaleCenter + options.scaleRadius
  const minOffsetX = options.offsetXCenter - options.offsetRadius
  const maxOffsetX = options.offsetXCenter + options.offsetRadius
  const minOffsetY = options.offsetYCenter - options.offsetRadius
  const maxOffsetY = options.offsetYCenter + options.offsetRadius

  for (let scale = minScale; scale <= maxScale + 0.0001; scale += options.scaleStep) {
    for (let offsetY = minOffsetY; offsetY <= maxOffsetY; offsetY += options.offsetStep) {
      for (let offsetX = minOffsetX; offsetX <= maxOffsetX; offsetX += options.offsetStep) {
        let hits = 0
        let inside = 0

        for (const [x, y] of points) {
          const tx = Math.round(options.centerX + offsetX + (x - options.centerX) * scale)
          const ty = Math.round(options.centerY + offsetY + (y - options.centerY) * scale)
          if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue
          inside += 1
          if (targetHitMask[ty * width + tx]) hits += 1
        }

        const score = inside > 0 ? hits / inside : 0
        if (score > best.score) {
          best = { scale, offsetX, offsetY, score }
        }
      }
    }
  }

  return best
}

function dilateMask(mask: Uint8Array, width: number, height: number, radius: number) {
  const result = new Uint8Array(mask.length)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue
      for (let dy = -radius; dy <= radius; dy += 1) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        for (let dx = -radius; dx <= radius; dx += 1) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          result[yy * width + xx] = 1
        }
      }
    }
  }

  return result
}

function denoiseMask(mask: Uint8Array, width: number, height: number, minimumNeighbors: number) {
  const result = new Uint8Array(mask.length)
  const threshold = clamp(Math.round(minimumNeighbors), 1, 9)

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x
      if (!mask[index]) continue

      let neighbors = 0
      for (let yy = y - 1; yy <= y + 1; yy += 1) {
        for (let xx = x - 1; xx <= x + 1; xx += 1) {
          neighbors += mask[yy * width + xx]
        }
      }
      if (neighbors >= threshold) result[index] = 1
    }
  }

  return result
}

function distanceTransform(mask: Uint8Array, width: number, height: number) {
  const diagonal = Math.SQRT2
  const dist = new Float32Array(mask.length)
  const inf = width + height

  for (let index = 0; index < mask.length; index += 1) {
    dist[index] = mask[index] ? 0 : inf
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      let best = dist[index]
      if (x > 0) best = Math.min(best, dist[index - 1] + 1)
      if (y > 0) best = Math.min(best, dist[index - width] + 1)
      if (x > 0 && y > 0) best = Math.min(best, dist[index - width - 1] + diagonal)
      if (x < width - 1 && y > 0) best = Math.min(best, dist[index - width + 1] + diagonal)
      dist[index] = best
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x
      let best = dist[index]
      if (x < width - 1) best = Math.min(best, dist[index + 1] + 1)
      if (y < height - 1) best = Math.min(best, dist[index + width] + 1)
      if (x < width - 1 && y < height - 1) best = Math.min(best, dist[index + width + 1] + diagonal)
      if (x > 0 && y < height - 1) best = Math.min(best, dist[index + width - 1] + diagonal)
      dist[index] = best
    }
  }

  return dist
}

function otsuThreshold(histogram: number[]) {
  const total = histogram.reduce((sum, count) => sum + count, 0)
  if (!total) return 128

  let sum = 0
  for (let index = 0; index < histogram.length; index += 1) {
    sum += index * histogram[index]
  }

  let backgroundWeight = 0
  let backgroundSum = 0
  let bestVariance = -1
  let threshold = 128

  for (let index = 0; index < histogram.length; index += 1) {
    backgroundWeight += histogram[index]
    if (!backgroundWeight) continue

    const foregroundWeight = total - backgroundWeight
    if (!foregroundWeight) break

    backgroundSum += index * histogram[index]
    const backgroundMean = backgroundSum / backgroundWeight
    const foregroundMean = (sum - backgroundSum) / foregroundWeight
    const variance =
      backgroundWeight *
      foregroundWeight *
      (backgroundMean - foregroundMean) *
      (backgroundMean - foregroundMean)

    if (variance > bestVariance) {
      bestVariance = variance
      threshold = index
    }
  }

  return threshold
}

function rgbToHsl(red: number, green: number, blue: number) {
  const r = red / 255
  const g = green / 255
  const b = blue / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const lightness = (max + min) / 2

  if (max === min) {
    return { h: 0, s: 0, l: lightness }
  }

  const delta = max - min
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let hue = 0

  if (max === r) {
    hue = (g - b) / delta + (g < b ? 6 : 0)
  } else if (max === g) {
    hue = (b - r) / delta + 2
  } else {
    hue = (r - g) / delta + 4
  }

  return {
    h: hue * 60,
    s: saturation,
    l: lightness,
  }
}

function rgbToKeySpace(color: ScanExtractionColor) {
  return rgbToYcbcr(color.red, color.green, color.blue)
}

function keyDistance(
  red: number,
  green: number,
  blue: number,
  reference: ReturnType<typeof rgbToKeySpace>,
  settings: ScanExtractionSettings,
) {
  const current = rgbToYcbcr(red, green, blue)
  const chromaWeight = Math.max(0, settings.keyChromaWeight)
  const lumaWeight = Math.max(0, settings.keyLumaWeight)
  const chromaDistance =
    (current.cb - reference.cb) * (current.cb - reference.cb) +
    (current.cr - reference.cr) * (current.cr - reference.cr)
  const lumaDistance = (current.y - reference.y) * (current.y - reference.y)
  return Math.sqrt(chromaDistance * chromaWeight + lumaDistance * lumaWeight)
}

function rgbToYcbcr(red: number, green: number, blue: number) {
  return {
    y: red * 0.299 + green * 0.587 + blue * 0.114,
    cb: 128 - red * 0.168736 - green * 0.331264 + blue * 0.5,
    cr: 128 + red * 0.5 - green * 0.418688 - blue * 0.081312,
  }
}

function hueInRange(hue: number, minHue: number, maxHue: number) {
  const min = normalizeHue(minHue)
  const max = normalizeHue(maxHue)
  const value = normalizeHue(hue)
  if (Math.abs(max - min) < 0.0001) return true
  return min <= max ? value >= min && value <= max : value >= min || value <= max
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const x = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return x * x * (3 - 2 * x)
}

function normalizeHue(value: number) {
  return ((value % 360) + 360) % 360
}

function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return 1
  return sorted[Math.floor(sorted.length / 2)]
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function summarize(pixels: number, x: number, y: number): MaskSummary {
  return {
    pixels,
    cx: pixels > 0 ? x / pixels : 0,
    cy: pixels > 0 ? y / pixels : 0,
  }
}

function paint(
  data: Uint8ClampedArray,
  offset: number,
  red: number,
  green: number,
  blue: number,
  alpha: number,
) {
  data[offset] = red
  data[offset + 1] = green
  data[offset + 2] = blue
  data[offset + 3] = alpha
}

function imageDataToUrl(imageData: ImageData) {
  const canvas = document.createElement('canvas')
  canvas.width = imageData.width
  canvas.height = imageData.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D is not available')
  context.putImageData(imageData, 0, 0)
  return new Promise<string>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Heatmap image could not be encoded'))
        return
      }
      resolve(URL.createObjectURL(blob))
    }, 'image/png')
  })
}

function svgToBlob(svg: string) {
  return new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
}

function loadHtmlImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Scan image could not be loaded'))
    image.src = url
  })
}
