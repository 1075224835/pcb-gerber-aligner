export type LayerKind =
  | 'copper'
  | 'mask'
  | 'paste'
  | 'silkscreen'
  | 'outline'
  | 'drill'
  | 'mechanical'
  | 'other'

export interface GerberLayer {
  id: string
  name: string
  extension: string
  kind: LayerKind
  svg: string
  svgBody: string
  viewBox: [number, number, number, number]
  width: number
  height: number
  units: 'mm' | 'in' | ''
  physicalOrder: number | null
  color: string
  opacity: number
  visible: boolean
  warnings: string[]
}

export interface ScanImage {
  id: string
  name: string
  url: string
  width: number
  height: number
}

export type ScanExtractionMode = 'dark' | 'color' | 'key'

export interface ScanExtractionColor {
  red: number
  green: number
  blue: number
}

export interface ScanExtractionSettings {
  mode: ScanExtractionMode
  threshold: number
  invert: boolean
  adaptive: boolean
  minChroma: number
  hueMin: number
  hueMax: number
  minSaturation: number
  maxSaturation: number
  minLightness: number
  maxLightness: number
  rejectGreen: boolean
  greenDominance: number
  keyColor: ScanExtractionColor | null
  keyTolerance: number
  keySoftness: number
  keyChromaWeight: number
  keyLumaWeight: number
  keySampleRadius: number
  keyMatteThreshold: number
  denoise: number
  grow: number
}

export interface AlignmentState {
  offsetX: number
  offsetY: number
  scale: number
  rotation: number
  scanOpacity: number
  extraction: ScanExtractionSettings
}

export interface AnalysisMetrics {
  canvasWidth: number
  canvasHeight: number
  referencePixels: number
  scanPixels: number
  overlapPixels: number
  falsePositivePixels: number
  falseNegativePixels: number
  mismatchRatio: number
  coverageRatio: number
  centroidDeltaX: number
  centroidDeltaY: number
  heatmapUrl: string
}

export interface ScanExtractionPreview {
  url: string
  selectedPixels: number
  totalPixels: number
}

export interface AutoAlignResult {
  alignment: AlignmentState
  analysis: AnalysisMetrics
  score: number
}
