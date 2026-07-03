import {
  Activity,
  BookOpen,
  Crosshair,
  FileImage,
  FolderOpen,
  Layers3,
  Loader2,
  Pipette,
  RefreshCw,
  RotateCcw,
  Ruler,
  ScanLine,
  WandSparkles,
  X,
  ZoomIn,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent, ReactNode, WheelEvent } from 'react'
import './App.css'
import {
  boardSizeMm,
  convertGerberFile,
  convertGerberText,
  isRenderableGerberFile,
  layerKindLabel,
  unionViewBox,
} from './lib/gerber'
import {
  autoAlignScan,
  buildCompositeSvg,
  createScanExtractionPreview,
  runAlignmentAnalysis,
} from './lib/imageAnalysis'
import { applyScanLayerCombination, matchLayersForScan } from './lib/layerMatching'
import type {
  AlignmentState,
  AnalysisMetrics,
  GerberLayer,
  ScanExtractionColor,
  ScanExtractionPreview,
  ScanExtractionSettings,
  ScanImage,
} from './types'

const INITIAL_EXTRACTION: ScanExtractionSettings = {
  mode: 'key',
  threshold: 145,
  invert: false,
  adaptive: true,
  minChroma: 18,
  hueMin: 0,
  hueMax: 360,
  minSaturation: 0,
  maxSaturation: 100,
  minLightness: 0,
  maxLightness: 55,
  rejectGreen: true,
  greenDominance: 1.05,
  keyColor: null,
  keyTolerance: 42,
  keySoftness: 36,
  keyChromaWeight: 1.4,
  keyLumaWeight: 0.35,
  keySampleRadius: 3,
  keyMatteThreshold: 0.45,
  denoise: 3,
  grow: 0,
}

const INITIAL_ALIGNMENT: AlignmentState = {
  offsetX: 0,
  offsetY: 8,
  scale: 1.05,
  rotation: 0,
  scanOpacity: 0.58,
  extraction: INITIAL_EXTRACTION,
}

interface ViewportState {
  scale: number
  x: number
  y: number
}

interface StageSize {
  width: number
  height: number
}

const INITIAL_VIEWPORT: ViewportState = {
  scale: 1,
  x: 0,
  y: 0,
}

const CALIBRATION_STORAGE_KEY = 'pcb-gerber-aligner.calibrations.v1'
const LAST_GERBER_DIRECTORY_KEY = 'pcb-gerber-aligner.last-gerber-directory.v1'
const LAST_SCAN_DIRECTORY_KEY = 'pcb-gerber-aligner.last-scan-directory.v1'

type CalibrationTarget = 'gerber' | 'scan'
type ViewMode = 'edit' | 'extract' | 'analysis'
type LineHandle = 'start' | 'end' | 'body'
type EditLayerFocus = 'gerber' | 'scan' | null

interface StagePoint {
  x: number
  y: number
}

interface CalibrationLine {
  start: StagePoint
  end: StagePoint
}

interface CalibrationLines {
  gerber: CalibrationLine | null
  scan: CalibrationLine | null
}

interface DraftLine extends CalibrationLine {
  target: CalibrationTarget
  pointerId: number
}

interface LineDrag {
  pointerId: number
  target: CalibrationTarget
  handle: LineHandle
  previousPoint: StagePoint
}

interface StoredCalibration {
  alignment: AlignmentState
  lines: CalibrationLines
  updatedAt: number
}

type StoredCalibrationMap = Record<string, StoredCalibration>

interface ImportedGerberFile {
  name: string
  path: string
  text: string
  size: number
  modifiedMs: number
}

interface ImportedScanFile {
  name: string
  path: string
  bytesBase64: string
  mimeType: string
  size: number
  modifiedMs: number
}

interface ImportedDirectory<FileType> {
  directory: string
  files: FileType[]
}

function emptyCalibrationLines(): CalibrationLines {
  return { gerber: null, scan: null }
}

function App() {
  const [layers, setLayers] = useState<GerberLayer[]>([])
  const [scanImages, setScanImages] = useState<ScanImage[]>([])
  const [selectedScanId, setSelectedScanId] = useState<string | null>(null)
  const [alignment, setAlignment] = useState(INITIAL_ALIGNMENT)
  const [analysis, setAnalysis] = useState<AnalysisMetrics | null>(null)
  const [extractionPreview, setExtractionPreview] = useState<ScanExtractionPreview | null>(null)
  const [status, setStatus] = useState('等待导入')
  const [busy, setBusy] = useState(false)
  const [busyMessage, setBusyMessage] = useState<string | null>(null)
  const [eyedropperActive, setEyedropperActive] = useState(false)
  const [selectedKind, setSelectedKind] = useState('all')
  const [viewMode, setViewMode] = useState<ViewMode>('edit')
  const [editLayerFocus, setEditLayerFocus] = useState<EditLayerFocus>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [lastGerberDirectory, setLastGerberDirectory] = useState(() =>
    loadStoredString(LAST_GERBER_DIRECTORY_KEY),
  )
  const [lastScanDirectory, setLastScanDirectory] = useState(() =>
    loadStoredString(LAST_SCAN_DIRECTORY_KEY),
  )
  const [viewport, setViewport] = useState(INITIAL_VIEWPORT)
  const [stageSize, setStageSize] = useState<StageSize | null>(null)
  const [dragStart, setDragStart] = useState<{
    pointerId: number
    x: number
    y: number
    viewportX: number
    viewportY: number
    viewportScale: number
  } | null>(null)
  const [calibrationMode, setCalibrationMode] = useState<CalibrationTarget | null>(null)
  const [calibrationLines, setCalibrationLines] = useState<CalibrationLines>(
    emptyCalibrationLines,
  )
  const [storedCalibrations, setStoredCalibrations] = useState<StoredCalibrationMap>(
    loadStoredCalibrations,
  )
  const [lineDraft, setLineDraft] = useState<DraftLine | null>(null)
  const [lineDrag, setLineDrag] = useState<LineDrag | null>(null)
  const gerberInputRef = useRef<HTMLInputElement | null>(null)
  const scanInputRef = useRef<HTMLInputElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const stageContentRef = useRef<HTMLDivElement | null>(null)
  const stageSizeRef = useRef<StageSize | null>(null)
  const viewportRef = useRef(viewport)
  const alignmentRef = useRef(alignment)
  const calibrationLinesRef = useRef(calibrationLines)
  const storedCalibrationsRef = useRef(storedCalibrations)
  const scanRef = useRef<ScanImage | null>(null)
  const lineDraftRef = useRef(lineDraft)
  const lineDragRef = useRef(lineDrag)
  const autoPanPointerRef = useRef<{ clientX: number; clientY: number } | null>(null)
  const autoPanTimerRef = useRef<number | null>(null)
  const viewportFrameRef = useRef<number | null>(null)
  const extractionPreviewRequestRef = useRef(0)

  const scan = useMemo(
    () => scanImages.find((image) => image.id === selectedScanId) ?? scanImages[0] ?? null,
    [scanImages, selectedScanId],
  )
  const visibleLayers = useMemo(() => layers.filter((layer) => layer.visible), [layers])
  const boardViewBox = useMemo(() => unionViewBox(layers), [layers])
  const visibleViewBox = useMemo(() => unionViewBox(visibleLayers.length ? visibleLayers : layers), [
    layers,
    visibleLayers,
  ])
  const size = boardSizeMm(boardViewBox)
  const compositeSvg = useMemo(
    () => buildCompositeSvg(visibleLayers, visibleViewBox),
    [visibleLayers, visibleViewBox],
  )
  const filteredLayers = useMemo(
    () =>
      selectedKind === 'all'
        ? layers
        : layers.filter((layer) => layer.kind === selectedKind),
    [layers, selectedKind],
  )
  const activeMatch = useMemo(
    () => (scan ? matchLayersForScan(scan.name, layers) : null),
    [layers, scan],
  )
  const activeLineTarget = calibrationMode ?? lineDraft?.target ?? lineDrag?.target ?? null

  useEffect(() => {
    viewportRef.current = viewport
    const element = stageContentRef.current
    if (element) element.style.transform = viewportTransform(viewport)
  }, [viewport])

  useEffect(() => {
    const element = stageRef.current
    if (!element) return

    let frame: number | null = null
    const updateStageSize = () => {
      frame = null
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return

      const nextSize = {
        width: rect.width,
        height: rect.height,
      }
      const currentSize = stageSizeRef.current
      if (
        currentSize &&
        Math.abs(currentSize.width - nextSize.width) < 0.5 &&
        Math.abs(currentSize.height - nextSize.height) < 0.5
      ) {
        return
      }

      stageSizeRef.current = nextSize
      setStageSize(nextSize)
    }

    updateStageSize()
    const observer = new ResizeObserver(() => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(updateStageSize)
    })
    observer.observe(element)

    return () => {
      observer.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [])

  useEffect(() => {
    alignmentRef.current = alignment
  }, [alignment])

  useEffect(() => {
    calibrationLinesRef.current = calibrationLines
  }, [calibrationLines])

  useEffect(() => {
    storedCalibrationsRef.current = storedCalibrations
  }, [storedCalibrations])

  useEffect(() => {
    scanRef.current = scan
  }, [scan])

  useEffect(() => {
    if (viewMode !== 'extract' && eyedropperActive) setEyedropperActive(false)
  }, [eyedropperActive, viewMode])

  useEffect(() => {
    lineDraftRef.current = lineDraft
  }, [lineDraft])

  useEffect(() => {
    lineDragRef.current = lineDrag
  }, [lineDrag])

  useEffect(() => {
    const hasActiveLineAction = Boolean(lineDraft || lineDrag)
    if (!hasActiveLineAction) {
      stopAutoPanLoop()
      return
    }

    if (autoPanTimerRef.current !== null) return
    autoPanTimerRef.current = window.setInterval(runAutoPanStep, 32)
    return stopAutoPanLoop
  }, [lineDraft, lineDrag])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (manualOpen) {
        if (event.key === 'Escape') {
          event.preventDefault()
          setManualOpen(false)
        }
        return
      }

      if (isEditableShortcutTarget(event.target) || event.ctrlKey || event.altKey || event.metaKey) {
        return
      }

      if (event.key === 'Escape' && (calibrationMode || lineDraft || lineDrag)) {
        event.preventDefault()
        setCalibrationMode(null)
        setLineDraft(null)
        setLineDrag(null)
        stopAutoPanLoop()
        setStatus('已取消划线操作')
        return
      }

      if (event.key === 'Escape' && editLayerFocus) {
        event.preventDefault()
        setEditLayerFocus(null)
        setStatus('已恢复叠加显示')
        return
      }

      if (event.key === 'Escape' && eyedropperActive) {
        event.preventDefault()
        setEyedropperActive(false)
        setStatus('已取消吸管取色')
        return
      }

      if (event.key === 'Escape' && (viewMode === 'analysis' || viewMode === 'extract')) {
        event.preventDefault()
        setViewMode('edit')
        setStatus('已返回编辑模式')
        return
      }

      if (event.repeat || event.key.toLowerCase() !== 'v') return
      if (viewMode !== 'edit') return

      event.preventDefault()
      if (!scan || !visibleLayers.length) {
        setStatus('快捷切换需要 Gerber 和扫描图')
        return
      }

      const nextFocus = editLayerFocus === 'gerber' ? 'scan' : 'gerber'
      setEditLayerFocus(nextFocus)
      setStatus(
        nextFocus === 'gerber'
          ? 'Gerber 100%，扫描图隐藏'
          : '扫描图 100%，Gerber 隐藏',
      )
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    calibrationMode,
    editLayerFocus,
    eyedropperActive,
    lineDraft,
    lineDrag,
    manualOpen,
    scan,
    viewMode,
    visibleLayers.length,
  ])

  useEffect(
    () => () => {
      if (analysis?.heatmapUrl.startsWith('blob:')) {
        URL.revokeObjectURL(analysis.heatmapUrl)
      }
    },
    [analysis],
  )

  useEffect(
    () => () => {
      if (extractionPreview?.url.startsWith('blob:')) {
        URL.revokeObjectURL(extractionPreview.url)
      }
    },
    [extractionPreview],
  )

  useEffect(() => {
    if (viewMode !== 'extract' || !scan || !stageSize) return

    const requestId = extractionPreviewRequestRef.current + 1
    extractionPreviewRequestRef.current = requestId
    const timer = window.setTimeout(() => {
      void createScanExtractionPreview(scan, alignment, stageSize)
        .then((preview) => {
          if (extractionPreviewRequestRef.current !== requestId) {
            URL.revokeObjectURL(preview.url)
            return
          }
          setExtractionPreview(preview)
        })
        .catch((error) => {
          if (extractionPreviewRequestRef.current === requestId) {
            setStatus(error instanceof Error ? error.message : '扫描提取预览失败')
          }
        })
    }, 90)

    return () => {
      window.clearTimeout(timer)
    }
  }, [alignment, scan, stageSize, viewMode])

  useEffect(
    () => () => {
      revokeScanImageUrls(scanImages)
    },
    [scanImages],
  )

  useEffect(
    () => () => {
      stopAutoPanLoop()
      if (viewportFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportFrameRef.current)
      }
    },
    [],
  )

  function saveCurrentCalibration() {
    saveCalibrationForScan(scanRef.current, alignmentRef.current, calibrationLinesRef.current)
  }

  function saveCalibrationForScan(
    currentScan: ScanImage | null,
    nextAlignment: AlignmentState,
    nextLines: CalibrationLines,
  ) {
    if (!currentScan) return

    const key = getCalibrationKey(currentScan)
    const nextRecord: StoredCalibration = {
      alignment: nextAlignment,
      lines: cloneCalibrationLines(nextLines),
      updatedAt: Date.now(),
    }
    const nextStore = {
      ...storedCalibrationsRef.current,
      [key]: nextRecord,
    }

    storedCalibrationsRef.current = nextStore
    setStoredCalibrations(nextStore)
    persistStoredCalibrations(nextStore)
  }

  function removeCalibrationForCurrentScan() {
    const currentScan = scanRef.current
    if (!currentScan) return

    const key = getCalibrationKey(currentScan)
    const nextStore = { ...storedCalibrationsRef.current }
    delete nextStore[key]
    storedCalibrationsRef.current = nextStore
    setStoredCalibrations(nextStore)
    persistStoredCalibrations(nextStore)
  }

  function restoreCalibrationForScan(nextScan: ScanImage | null) {
    if (!nextScan) return false

    const saved = storedCalibrationsRef.current[getCalibrationKey(nextScan)]
    if (!saved) return false

    const savedAlignment = normalizeAlignment(saved.alignment)
    const savedLines = cloneCalibrationLines(saved.lines)
    alignmentRef.current = savedAlignment
    calibrationLinesRef.current = savedLines
    setAlignment(savedAlignment)
    setCalibrationLines(savedLines)
    setLineDraft(null)
    setLineDrag(null)
    setCalibrationMode(null)
    setAnalysis(null)
    setViewMode('edit')
    return true
  }

  function commitAlignment(
    nextAlignment: AlignmentState,
    nextLines = calibrationLinesRef.current,
    currentScan = scanRef.current,
  ) {
    alignmentRef.current = nextAlignment
    setAlignment(nextAlignment)
    setAnalysis(null)
    saveCalibrationForScan(currentScan, nextAlignment, nextLines)
  }

  function commitCalibrationLines(nextLines: CalibrationLines) {
    calibrationLinesRef.current = nextLines
    setCalibrationLines(nextLines)
    saveCalibrationForScan(scanRef.current, alignmentRef.current, nextLines)
  }

  async function openGerberDirectory() {
    if (!hasTauriRuntime()) {
      gerberInputRef.current?.click()
      return
    }

    try {
      const result = await invoke<ImportedDirectory<ImportedGerberFile> | null>(
        'pick_gerber_directory',
        { defaultDirectory: lastGerberDirectory || null },
      )
      if (!result) return

      setLastGerberDirectory(result.directory)
      persistStoredString(LAST_GERBER_DIRECTORY_KEY, result.directory)
      await handleImportedGerberFiles(result.files)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Gerber 文件夹导入失败')
    }
  }

  async function openScanDirectory() {
    if (!hasTauriRuntime()) {
      scanInputRef.current?.click()
      return
    }

    try {
      const result = await invoke<ImportedDirectory<ImportedScanFile> | null>(
        'pick_scan_directory',
        { defaultDirectory: lastScanDirectory || null },
      )
      if (!result) return

      setLastScanDirectory(result.directory)
      persistStoredString(LAST_SCAN_DIRECTORY_KEY, result.directory)
      await handleImportedScanFiles(result.files)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '扫描图文件夹导入失败')
    }
  }

  async function chooseGerberDirectory() {
    if (!hasTauriRuntime()) {
      gerberInputRef.current?.click()
      return
    }

    try {
      const directory = await invoke<string | null>('pick_gerber_directory_path', {
        defaultDirectory: lastGerberDirectory || null,
      })
      if (!directory) return

      setLastGerberDirectory(directory)
      persistStoredString(LAST_GERBER_DIRECTORY_KEY, directory)
      setStatus(`Gerber directory selected: ${compactPath(directory)}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Gerber directory selection failed')
    }
  }

  async function importSelectedGerberDirectory() {
    if (!hasTauriRuntime()) {
      gerberInputRef.current?.click()
      return
    }

    if (!lastGerberDirectory) {
      setStatus('Select a Gerber directory first')
      return
    }

    try {
      setBusy(true)
      setBusyMessage('正在读取 Gerber 目录...')
      setStatus('正在读取 Gerber 目录...')
      await waitForNextPaint()

      const result = await invoke<ImportedDirectory<ImportedGerberFile>>(
        'import_gerber_directory',
        { directory: lastGerberDirectory },
      )
      setLastGerberDirectory(result.directory)
      persistStoredString(LAST_GERBER_DIRECTORY_KEY, result.directory)
      setBusyMessage('正在解析 Gerber 图层...')
      setStatus('正在解析 Gerber 图层...')
      await waitForNextPaint()
      await handleImportedGerberFiles(result.files)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Gerber directory import failed')
      setBusy(false)
      setBusyMessage(null)
    }
  }

  async function chooseScanDirectory() {
    if (!hasTauriRuntime()) {
      scanInputRef.current?.click()
      return
    }

    try {
      const directory = await invoke<string | null>('pick_scan_directory_path', {
        defaultDirectory: lastScanDirectory || null,
      })
      if (!directory) return

      setLastScanDirectory(directory)
      persistStoredString(LAST_SCAN_DIRECTORY_KEY, directory)
      setStatus(`Scan directory selected: ${compactPath(directory)}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Scan directory selection failed')
    }
  }

  async function importSelectedScanDirectory() {
    if (!hasTauriRuntime()) {
      scanInputRef.current?.click()
      return
    }

    if (!lastScanDirectory) {
      setStatus('Select a scan image directory first')
      return
    }

    try {
      const result = await invoke<ImportedDirectory<ImportedScanFile>>(
        'import_scan_directory',
        { directory: lastScanDirectory },
      )
      setLastScanDirectory(result.directory)
      persistStoredString(LAST_SCAN_DIRECTORY_KEY, result.directory)
      await handleImportedScanFiles(result.files)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Scan directory import failed')
    }
  }

  async function handleImportedGerberFiles(files: ImportedGerberFile[]) {
    if (!files.length) {
      setStatus('未找到 Gerber 文件')
      setBusy(false)
      setBusyMessage(null)
      return
    }

    saveCurrentCalibration()
    setBusy(true)
    setBusyMessage('正在解析 Gerber 图层...')
    setAnalysis(null)
    setStatus('正在解析 Gerber')
    await waitForNextPaint()

    try {
      const candidates = files
        .filter((file) => isRenderableGerberFile(file.name))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))

      if (!candidates.length) {
        setStatus('未找到可渲染的 Gerber 图层')
        return
      }

      const converted = await Promise.all(
        candidates.map((file, index) => convertGerberText(file.name, file.text, index)),
      )
      await applyGerberImport(converted)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Gerber 解析失败')
    } finally {
      setBusy(false)
      setBusyMessage(null)
    }
  }

  async function applyGerberImport(converted: GerberLayer[]) {
    const currentScan = scanRef.current
    if (currentScan) {
      const nextLayers = applyScanLayerCombination(currentScan.name, converted)
      setLayers(nextLayers)
      if (restoreCalibrationForScan(currentScan)) {
        setStatus(`已载入 ${converted.length} 个可渲染层，已恢复 ${currentScan.name} 的配准`)
      } else {
        setStatus(`已载入 ${converted.length} 个可渲染层，已匹配 ${currentScan.name}`)
        await runAutoAlign(currentScan, nextLayers)
      }
    } else {
      setLayers(converted)
      setStatus(`已载入 ${converted.length} 个可渲染层`)
    }
  }

  async function handleGerberFiles(files: FileList | null) {
    if (!files?.length) return

    saveCurrentCalibration()
    setBusy(true)
    setAnalysis(null)
    setStatus('正在解析 Gerber')

    try {
      const candidates = Array.from(files)
        .filter((file) => isRenderableGerberFile(file.name))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))

      const converted = await Promise.all(
        candidates.map((file, index) => convertGerberFile(file, index)),
      )

      const currentScan = scanRef.current
      if (currentScan) {
        const nextLayers = applyScanLayerCombination(currentScan.name, converted)
        setLayers(nextLayers)
        if (restoreCalibrationForScan(currentScan)) {
          setStatus(`已载入 ${converted.length} 个可渲染层，已恢复 ${currentScan.name} 的配准`)
        } else {
          setStatus(`已载入 ${converted.length} 个可渲染层，已匹配 ${currentScan.name}`)
          await runAutoAlign(currentScan, nextLayers)
        }
      } else {
        setLayers(converted)
        setStatus(`已载入 ${converted.length} 个可渲染层`)
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Gerber 解析失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleImportedScanFiles(files: ImportedScanFile[]) {
    if (!files.length) return

    saveCurrentCalibration()
    setBusy(true)
    setAnalysis(null)
    setStatus('正在读取扫描图')

    try {
      const imageFiles = files
        .filter((file) => isImageImport(file.name, file.mimeType))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
      const loaded = await loadImportedScanImages(imageFiles)
      await applyScanImport(loaded)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '扫描图读取失败')
    } finally {
      setBusy(false)
    }
  }

  async function applyScanImport(loaded: ScanImage[]) {
    setScanImages(loaded)

    const firstScan = loaded[0] ?? null
    if (!firstScan) {
      setStatus('未找到扫描图片')
      return
    }

    setSelectedScanId(firstScan.id)
    if (layers.length) {
      const nextLayers = applyScanLayerCombination(firstScan.name, layers)
      setLayers(nextLayers)
      if (restoreCalibrationForScan(firstScan)) {
        setStatus(`已载入 ${loaded.length} 张扫描图，已恢复 ${firstScan.name} 的配准`)
      } else {
        setStatus(`已载入 ${loaded.length} 张扫描图，已匹配 ${firstScan.name}`)
        await runAutoAlign(firstScan, nextLayers)
      }
    } else if (restoreCalibrationForScan(firstScan)) {
      setStatus(`已载入 ${loaded.length} 张扫描图，已恢复 ${firstScan.name} 的配准`)
    } else {
      setStatus(`已载入 ${loaded.length} 张扫描图`)
    }
  }

  async function handleScanFiles(files: FileList | null) {
    if (!files?.length) return

    saveCurrentCalibration()
    setBusy(true)
    setAnalysis(null)
    setStatus('正在读取扫描图')

    try {
      const imageFiles = Array.from(files)
        .filter((file) => file.type.startsWith('image/'))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
      const loaded = await loadBrowserScanImages(imageFiles)
      setScanImages(loaded)

      const firstScan = loaded[0] ?? null
      if (!firstScan) {
        setStatus('未找到扫描图片')
        return
      }

      setSelectedScanId(firstScan.id)
      if (layers.length) {
        const nextLayers = applyScanLayerCombination(firstScan.name, layers)
        setLayers(nextLayers)
        if (restoreCalibrationForScan(firstScan)) {
          setStatus(`已载入 ${loaded.length} 张扫描图，已恢复 ${firstScan.name} 的配准`)
        } else {
          setStatus(`已载入 ${loaded.length} 张扫描图，已匹配 ${firstScan.name}`)
          await runAutoAlign(firstScan, nextLayers)
        }
      } else if (restoreCalibrationForScan(firstScan)) {
        setStatus(`已载入 ${loaded.length} 张扫描图，已恢复 ${firstScan.name} 的配准`)
      } else {
        setStatus(`已载入 ${loaded.length} 张扫描图`)
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '扫描图读取失败')
    } finally {
      setBusy(false)
    }
  }

  async function analyze() {
    if (!scan || !visibleLayers.length) {
      setStatus('需要至少一个可见 Gerber 层和一张扫描图')
      return
    }

    setBusy(true)
    setStatus('正在计算偏差')
    try {
      const result = await runAlignmentAnalysis(
        visibleLayers,
        visibleViewBox,
        scan,
        alignment,
        getStageSize(),
      )
      setAnalysis(result)
      setViewMode('analysis')
      setStatus(`偏差 ${percent(result.mismatchRatio)}，覆盖 ${percent(result.coverageRatio)}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '偏差计算失败')
    } finally {
      setBusy(false)
    }
  }

  async function selectScan(nextScan: ScanImage) {
    saveCurrentCalibration()
    setSelectedScanId(nextScan.id)
    setAnalysis(null)
    if (!layers.length) {
      if (restoreCalibrationForScan(nextScan)) {
        setStatus(`已恢复 ${nextScan.name} 的配准`)
      } else {
        setStatus(`已选择 ${nextScan.name}`)
      }
      return
    }

    const nextLayers = applyScanLayerCombination(nextScan.name, layers)
    setLayers(nextLayers)
    if (restoreCalibrationForScan(nextScan)) {
      setStatus(`已按 ${nextScan.name} 自动切换组合，并恢复配准`)
    } else {
      setStatus(`已按 ${nextScan.name} 自动切换组合`)
      await runAutoAlign(nextScan, nextLayers)
    }
  }

  async function runAutoAlign(currentScan = scan, currentLayers = layers) {
    if (!currentScan || !currentLayers.length) {
      setStatus('需要 Gerber 线路层和扫描图')
      return
    }

    const matchedLayers = currentLayers.filter((layer) => layer.visible)
    if (!matchedLayers.length) {
      setStatus('未匹配到可见线路层组合')
      return
    }

    setBusy(true)
    setAnalysis(null)
    setStatus('正在自动缩放和移动对齐')

    try {
      const matchViewBox = unionViewBox(matchedLayers)
      const result = await autoAlignScan(
        matchedLayers,
        matchViewBox,
        currentScan,
        INITIAL_ALIGNMENT,
        getStageSize(),
      )
      commitAlignment(result.alignment, calibrationLinesRef.current, currentScan)
      setAnalysis(result.analysis)
      setStatus(
        `自动对齐完成：缩放 ${result.alignment.scale.toFixed(3)}，X ${result.alignment.offsetX}，Y ${result.alignment.offsetY}`,
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '自动对齐失败')
    } finally {
      setBusy(false)
    }
  }

  function updateLayer(id: string, patch: Partial<GerberLayer>) {
    setLayers((current) =>
      current.map((layer) => (layer.id === id ? { ...layer, ...patch } : layer)),
    )
    setAnalysis(null)
  }

  function setAlignmentValue<Key extends keyof AlignmentState>(
    key: Key,
    value: AlignmentState[Key],
  ) {
    if (key === 'scanOpacity') setEditLayerFocus(null)
    const nextAlignment = { ...alignmentRef.current, [key]: value } as AlignmentState
    commitAlignment(nextAlignment)
  }

  function setExtractionValue<Key extends keyof ScanExtractionSettings>(
    key: Key,
    value: ScanExtractionSettings[Key],
  ) {
    if (key === 'mode') setEyedropperActive(false)
    const nextAlignment = {
      ...alignmentRef.current,
      extraction: {
        ...alignmentRef.current.extraction,
        [key]: value,
      },
    }
    commitAlignment(nextAlignment)
    if (viewMode !== 'extract') setViewMode('extract')
  }

  function resetExtractionSettings() {
    commitAlignment({
      ...alignmentRef.current,
      extraction: { ...INITIAL_EXTRACTION },
    })
    setViewMode('extract')
    setStatus('已重置扫描提取参数')
  }

  function beginEyedropper() {
    if (!scanRef.current) {
      setStatus('需要先导入扫描图')
      return
    }

    setViewMode('extract')
    setExtractionValue('mode', 'key')
    setEyedropperActive(true)
    setStatus('吸管已启用：在主视窗点击要提取的线路颜色')
  }

  async function pickExtractionColor(point: StagePoint) {
    const currentScan = scanRef.current
    const stageSize = getStageSize()
    if (!currentScan || !stageSize) {
      setStatus('需要先导入扫描图')
      return
    }

    try {
      const color = await sampleScanColorAtStagePoint(
        currentScan,
        alignmentRef.current,
        stageSize,
        point,
        alignmentRef.current.extraction.keySampleRadius,
      )
      if (!color) {
        setStatus('取样点不在扫描图范围内')
        return
      }

      const nextAlignment = {
        ...alignmentRef.current,
        extraction: {
          ...alignmentRef.current.extraction,
          mode: 'key' as const,
          keyColor: color,
        },
      }
      commitAlignment(nextAlignment)
      setEyedropperActive(false)
      setViewMode('extract')
      setStatus(`已取样 RGB(${color.red}, ${color.green}, ${color.blue})，可继续微调抠图参数`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '吸管取色失败')
    }
  }

  function previewViewport(nextViewport: ViewportState, syncState = false) {
    viewportRef.current = nextViewport
    const element = stageContentRef.current
    if (element) element.style.transform = viewportTransform(nextViewport)

    if (!syncState || viewportFrameRef.current !== null) return

    viewportFrameRef.current = window.requestAnimationFrame(() => {
      viewportFrameRef.current = null
      setViewport(viewportRef.current)
    })
  }

  function commitViewport(nextViewport = viewportRef.current) {
    viewportRef.current = nextViewport
    const element = stageContentRef.current
    if (element) element.style.transform = viewportTransform(nextViewport)

    if (viewportFrameRef.current !== null) {
      window.cancelAnimationFrame(viewportFrameRef.current)
      viewportFrameRef.current = null
    }
    setViewport(nextViewport)
  }

  function resetViewport() {
    commitViewport(INITIAL_VIEWPORT)
  }

  function getStageSize() {
    if (stageSizeRef.current) return stageSizeRef.current

    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return undefined

    const nextSize = { width: rect.width, height: rect.height }
    stageSizeRef.current = nextSize
    return nextSize
  }

  function getStagePoint(event: PointerEvent<HTMLDivElement>): StagePoint | null {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return null
    return clientToStagePoint(event.clientX, event.clientY, rect)
  }

  function clientToStagePoint(
    clientX: number,
    clientY: number,
    rect: DOMRect,
    currentViewport = viewportRef.current,
  ): StagePoint {
    const centerX = rect.width / 2
    const centerY = rect.height / 2
    return {
      x: centerX + (clientX - rect.left - centerX - currentViewport.x) / currentViewport.scale,
      y: centerY + (clientY - rect.top - centerY - currentViewport.y) / currentViewport.scale,
    }
  }

  function stopAutoPanLoop() {
    if (autoPanTimerRef.current !== null) {
      window.clearInterval(autoPanTimerRef.current)
      autoPanTimerRef.current = null
    }
  }

  function runAutoPanStep() {
    const pointer = autoPanPointerRef.current
    const rect = stageRef.current?.getBoundingClientRect()
    if (!pointer || !rect || (!lineDraftRef.current && !lineDragRef.current)) return

    const edge = 42
    const maxStep = 22
    const left = pointer.clientX - rect.left
    const top = pointer.clientY - rect.top
    const right = rect.width - left
    const bottom = rect.height - top
    const dx = left < edge ? ((edge - left) / edge) * maxStep : right < edge ? -((edge - right) / edge) * maxStep : 0
    const dy = top < edge ? ((edge - top) / edge) * maxStep : bottom < edge ? -((edge - bottom) / edge) * maxStep : 0
    if (dx === 0 && dy === 0) return

    const nextViewport = {
      ...viewportRef.current,
      x: viewportRef.current.x + dx,
      y: viewportRef.current.y + dy,
    }
    previewViewport(nextViewport, true)

    const point = clientToStagePoint(pointer.clientX, pointer.clientY, rect, nextViewport)
    if (lineDraftRef.current) {
      setLineDraft((draft) => (draft ? { ...draft, end: point } : draft))
    }
    if (lineDragRef.current) {
      updateLineDragAtPoint(point)
    }
  }

  function beginLineCalibration(target: CalibrationTarget) {
    if (!scan || !visibleLayers.length) {
      setStatus('需要 Gerber 和扫描图')
      return
    }

    setCalibrationMode(target)
    setLineDraft(null)
    setDragStart(null)
    setStatus(target === 'gerber' ? '绘制 Gerber 参考线' : '绘制扫描图参考线')
  }

  function clearLineCalibration() {
    const nextLines = emptyCalibrationLines()
    calibrationLinesRef.current = nextLines
    setCalibrationLines(nextLines)
    setLineDraft(null)
    setLineDrag(null)
    setCalibrationMode(null)
    removeCalibrationForCurrentScan()
    setStatus('已清除当前图片的划线配准记录')
  }

  function applyLineCalibration(lines = calibrationLines) {
    const stageSize = getStageSize()
    if (!stageSize || !lines.gerber || !lines.scan) {
      setStatus('需要两条参考线')
      return
    }

    const nextAlignment = calculateLineAlignment(
      lines.gerber,
      lines.scan,
      stageSize,
      alignmentRef.current,
    )
    if (!nextAlignment) {
      setStatus('参考线太短')
      return
    }

    commitAlignment(nextAlignment, lines)
    setStatus(
      `划线配准完成：缩放 ${nextAlignment.scale.toFixed(4)}，X ${nextAlignment.offsetX}，Y ${nextAlignment.offsetY}`,
    )
  }

  function findLineHit(point: StagePoint): Omit<LineDrag, 'pointerId' | 'previousPoint'> | null {
    const stageSize = getStageSize()
    const radius = Math.max(5, 12 / viewportRef.current.scale)
    const candidates: Array<{ target: CalibrationTarget; line: CalibrationLine }> = []
    const lines = calibrationLinesRef.current

    if (lines.gerber) {
      candidates.push({ target: 'gerber', line: lines.gerber })
    }
    if (lines.scan && stageSize) {
      candidates.push({
        target: 'scan',
        line: transformScanLine(lines.scan, alignmentRef.current, stageSize),
      })
    }

    for (const candidate of candidates) {
      if (distance(point, candidate.line.start) <= radius) {
        return { target: candidate.target, handle: 'start' }
      }
      if (distance(point, candidate.line.end) <= radius) {
        return { target: candidate.target, handle: 'end' }
      }
    }

    for (const candidate of candidates) {
      if (distanceToSegment(point, candidate.line.start, candidate.line.end) <= radius) {
        return { target: candidate.target, handle: 'body' }
      }
    }

    return null
  }

  function updateLineDragAtPoint(point: StagePoint) {
    const drag = lineDragRef.current
    const stageSize = getStageSize()
    if (!drag || !stageSize) return

    setCalibrationLines((current) => {
      const next = updateDraggedLine(current, drag, point, alignmentRef.current, stageSize)
      calibrationLinesRef.current = next
      return next
    })
    if (drag.handle === 'body') {
      setLineDrag((current) => (current ? { ...current, previousPoint: point } : current))
    }
  }

  function handleStageWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault()
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return

    const currentViewport = viewportRef.current
    const nextScale = clamp(
      currentViewport.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12),
      0.35,
      6,
    )
    const pointerX = event.clientX - rect.left - rect.width / 2
    const pointerY = event.clientY - rect.top - rect.height / 2
    const ratio = nextScale / currentViewport.scale

    previewViewport({
      scale: nextScale,
      x: pointerX - (pointerX - currentViewport.x) * ratio,
      y: pointerY - (pointerY - currentViewport.y) * ratio,
    }, true)
  }

  function handleStagePointerDown(event: PointerEvent<HTMLDivElement>) {
    autoPanPointerRef.current = { clientX: event.clientX, clientY: event.clientY }

    if (viewMode === 'extract' && eyedropperActive) {
      const point = getStagePoint(event)
      if (!point) return

      event.preventDefault()
      void pickExtractionColor(point)
      return
    }

    if (viewMode === 'edit' && calibrationMode) {
      const point = getStagePoint(event)
      if (!point) return

      event.currentTarget.setPointerCapture(event.pointerId)
      setLineDraft({
        target: calibrationMode,
        pointerId: event.pointerId,
        start: point,
        end: point,
      })
      return
    }

    if (viewMode === 'edit') {
      const point = getStagePoint(event)
      const hit = point ? findLineHit(point) : null
      if (point && hit) {
        event.currentTarget.setPointerCapture(event.pointerId)
        setLineDrag({
          ...hit,
          pointerId: event.pointerId,
          previousPoint: point,
        })
        setDragStart(null)
        setStatus(hit.handle === 'body' ? '移动参考线' : '调整参考线端点')
        return
      }
    }

    const currentViewport = viewportRef.current
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragStart({
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      viewportX: currentViewport.x,
      viewportY: currentViewport.y,
      viewportScale: currentViewport.scale,
    })
  }

  function handleStagePointerMove(event: PointerEvent<HTMLDivElement>) {
    autoPanPointerRef.current = { clientX: event.clientX, clientY: event.clientY }

    if (lineDraft && lineDraft.pointerId === event.pointerId) {
      const point = getStagePoint(event)
      if (!point) return
      setLineDraft({ ...lineDraft, end: point })
      return
    }

    if (lineDrag && lineDrag.pointerId === event.pointerId) {
      const point = getStagePoint(event)
      if (!point) return
      updateLineDragAtPoint(point)
      return
    }

    if (!dragStart || dragStart.pointerId !== event.pointerId) return
    previewViewport({
      scale: dragStart.viewportScale,
      x: dragStart.viewportX + event.clientX - dragStart.x,
      y: dragStart.viewportY + event.clientY - dragStart.y,
    }, Boolean(calibrationLinesRef.current.gerber || calibrationLinesRef.current.scan))
  }

  function handleStagePointerUp(event: PointerEvent<HTMLDivElement>) {
    const currentDraft = lineDraftRef.current
    if (currentDraft?.pointerId === event.pointerId) {
      const end = getStagePoint(event) ?? currentDraft.end
      const line = { start: currentDraft.start, end }
      const stageSize = getStageSize()

      if (distance(line.start, line.end) < 12 || !stageSize) {
        setStatus('参考线太短')
      } else {
        const nextLines =
          currentDraft.target === 'gerber'
            ? { ...calibrationLinesRef.current, gerber: line }
            : {
                ...calibrationLinesRef.current,
                scan: invertScanLine(line, alignmentRef.current, stageSize),
              }
        commitCalibrationLines(nextLines)
        if (nextLines.gerber && nextLines.scan) {
          setStatus('已记录两条参考线，点击应用执行划线配准')
        } else {
          setStatus(currentDraft.target === 'gerber' ? '已记录 Gerber 线' : '已记录扫描图线')
        }
      }

      setLineDraft(null)
      setCalibrationMode(null)
      autoPanPointerRef.current = null
      commitViewport()
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      return
    }

    const currentLineDrag = lineDragRef.current
    if (currentLineDrag?.pointerId === event.pointerId) {
      setLineDrag(null)
      autoPanPointerRef.current = null
      commitCalibrationLines(calibrationLinesRef.current)
      setStatus(
        calibrationLinesRef.current.gerber && calibrationLinesRef.current.scan
          ? '参考线已调整，点击应用执行划线配准'
          : '参考线已调整',
      )
      commitViewport()
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      return
    }

    if (dragStart?.pointerId === event.pointerId) {
      setDragStart(null)
      commitViewport()
    }
    autoPanPointerRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const overlayStageSize = stageSize
  const editingGerberLine = activeLineTarget === 'gerber'
  const editingScanLine = activeLineTarget === 'scan'
  const showEditContent = viewMode === 'edit'
  const showExtractionContent = viewMode === 'extract'
  const showAnalysisContent = viewMode === 'analysis' && analysis
  const forceGerberOnly = showEditContent && !activeLineTarget && editLayerFocus === 'gerber'
  const forceScanOnly = showEditContent && !activeLineTarget && editLayerFocus === 'scan'
  const shortcutHints = buildShortcutHints({
    activeLineTarget,
    editLayerFocus,
    eyedropperActive,
    hasScan: Boolean(scan),
    hasVisibleLayers: visibleLayers.length > 0,
    lineDraftActive: Boolean(lineDraft),
    lineDragActive: Boolean(lineDrag),
    viewMode,
  })
  const gerberCanvasStyle = {
    opacity: showEditContent && !editingScanLine && !forceScanOnly ? 1 : 0,
  }
  const scanOverlayStyle = {
    opacity: showExtractionContent
      ? eyedropperActive
        ? 0.72
        : 0.34
      : showEditContent
      ? editingScanLine
        ? 1
        : editingGerberLine || forceGerberOnly
          ? 0
          : forceScanOnly
            ? 1
            : alignment.scanOpacity
      : 0,
    transform: `translate3d(${alignment.offsetX}px, ${alignment.offsetY}px, 0) rotate(${alignment.rotation}deg) scale(${alignment.scale})`,
  }
  const gerberOverlayLine =
    calibrationLines.gerber && overlayStageSize
      ? stageLineToScreenLine(calibrationLines.gerber, viewport, overlayStageSize)
      : null
  const scanOverlayLine =
    calibrationLines.scan && overlayStageSize
      ? stageLineToScreenLine(
          transformScanLine(calibrationLines.scan, alignment, overlayStageSize),
          viewport,
          overlayStageSize,
        )
      : null
  const draftOverlayLine =
    lineDraft && overlayStageSize
      ? stageLineToScreenLine(lineDraft, viewport, overlayStageSize)
      : null
  const tauriRuntime = hasTauriRuntime()

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <BrandMark />
          <div>
            <div className="brand-title-line">
              <h1>PCB Gerber Aligner</h1>
              <em>Design by 杨云龙</em>
            </div>
            <span>{status}</span>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="import-group">
            <button
              className="file-button"
              type="button"
              title={lastGerberDirectory || 'No Gerber directory selected'}
              onClick={() => void chooseGerberDirectory()}
              disabled={busy}
            >
              <FolderOpen size={18} />
              Gerber 路径
            </button>
            <button
              className="file-button import-button"
              type="button"
              title={lastGerberDirectory || 'Select a Gerber directory first'}
              onClick={() => void importSelectedGerberDirectory()}
              disabled={busy || (tauriRuntime && !lastGerberDirectory)}
            >
              <RefreshCw size={18} />
              导入 Gerber
            </button>
          </div>
          <div className="import-group">
            <button
              className="file-button"
              type="button"
              title={lastScanDirectory || 'No scan directory selected'}
              onClick={() => void chooseScanDirectory()}
              disabled={busy}
            >
              <FolderOpen size={18} />
              扫描路径
            </button>
            <button
              className="file-button import-button"
              type="button"
              title={lastScanDirectory || 'Select a scan image directory first'}
              onClick={() => void importSelectedScanDirectory()}
              disabled={busy || (tauriRuntime && !lastScanDirectory)}
            >
              <RefreshCw size={18} />
              导入扫描
            </button>
          </div>
          <div style={{ display: 'none' }}>
          <button
            className="file-button"
            type="button"
            onClick={() => void openGerberDirectory()}
            disabled={busy}
          >
            <FolderOpen size={18} />
            Gerber
          </button>
          <input
            ref={gerberInputRef}
            className="hidden-file-input"
            type="file"
            multiple
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            onChange={(event) => {
              void handleGerberFiles(event.target.files)
              event.currentTarget.value = ''
            }}
          />
          <button
            className="file-button"
            type="button"
            onClick={() => void openScanDirectory()}
            disabled={busy}
          >
            <FileImage size={18} />
            扫描图
          </button>
          <input
            ref={scanInputRef}
            className="hidden-file-input"
            type="file"
            accept="image/*"
            multiple
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            onChange={(event) => {
              void handleScanFiles(event.target.files)
              event.currentTarget.value = ''
            }}
          />
          <label className="file-button" style={{ display: 'none' }}>
            <FileImage size={18} />
            扫描图
            <input
              type="file"
              accept="image/*"
              multiple
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              onChange={(event) => void handleScanFiles(event.target.files)}
            />
          </label>
          </div>
          <button className="primary-button" type="button" onClick={() => void analyze()}>
            {busy ? <Loader2 size={18} className="spin" /> : <Activity size={18} />}
            分析
          </button>
          <button className="file-button help-button" type="button" onClick={() => setManualOpen(true)}>
            <BookOpen size={18} />
            说明书
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="side-panel">
          <PanelTitle icon={<Layers3 size={18} />} title="图层" value={`${layers.length}`} />

          <div className="segmented">
            {['all', 'copper', 'outline', 'drill', 'mechanical'].map((kind) => (
              <button
                key={kind}
                className={selectedKind === kind ? 'active' : ''}
                type="button"
                onClick={() => setSelectedKind(kind)}
              >
                {kind === 'all' ? '全部' : layerKindLabel(kind as GerberLayer['kind'])}
              </button>
            ))}
          </div>

          <div className="layer-list">
            {filteredLayers.map((layer) => (
              <div className="layer-row" key={layer.id}>
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={layer.visible}
                    onChange={(event) => updateLayer(layer.id, { visible: event.target.checked })}
                  />
                  <span className="swatch" style={{ background: layer.color }} />
                  <span className="layer-name" title={layer.name}>
                    {layer.name}
                  </span>
                </label>
                <div className="layer-meta">
                  <span>{layerKindLabel(layer.kind)}</span>
                  <span>
                    {layer.width.toFixed(1)} x {layer.height.toFixed(1)} {layer.units}
                  </span>
                </div>
                <input
                  aria-label={`${layer.name} opacity`}
                  type="range"
                  min="0.05"
                  max="1"
                  step="0.05"
                  value={layer.opacity}
                  onChange={(event) =>
                    updateLayer(layer.id, { opacity: Number(event.target.value) })
                  }
                />
              </div>
            ))}
          </div>
        </aside>

        <section className="viewer-panel">
          <div className="viewer-toolbar">
            <div>
              <strong>
                {size.width.toFixed(2)} mm x {size.height.toFixed(2)} mm
              </strong>
              <span>{visibleLayers.length} 个可见层</span>
            </div>
            <div className="view-controls">
              <ZoomIn size={15} />
              <span>{Math.round(viewport.scale * 100)}%</span>
              <button
                type="button"
                className={viewMode === 'edit' ? 'active' : ''}
                onClick={() => setViewMode('edit')}
              >
                编辑
              </button>
              <button
                type="button"
                className={viewMode === 'extract' ? 'active' : ''}
                onClick={() => setViewMode('extract')}
                disabled={!scan}
              >
                提取
              </button>
              <button
                type="button"
                className={viewMode === 'analysis' ? 'active' : ''}
                onClick={() => setViewMode('analysis')}
                disabled={!analysis}
              >
                偏差
              </button>
              <button type="button" onClick={resetViewport}>
                复位视图
              </button>
            </div>
            <div className="legend">
              <span>
                <i className="ok" /> 重合
              </span>
              <span>
                <i className="miss" /> Gerber
              </span>
              <span>
                <i className="extra" /> 扫描
              </span>
            </div>
          </div>

          <div
            className={`board-stage ${dragStart ? 'dragging' : ''} ${activeLineTarget ? 'calibrating' : ''} ${eyedropperActive ? 'picking' : ''}`}
            ref={stageRef}
            onWheel={handleStageWheel}
            onPointerDown={handleStagePointerDown}
            onPointerMove={handleStagePointerMove}
            onPointerUp={handleStagePointerUp}
            onPointerCancel={handleStagePointerUp}
            onDoubleClick={resetViewport}
          >
            <div
              className="stage-content"
              ref={stageContentRef}
              style={{
                transform: viewportTransform(viewport),
              }}
            >
              {visibleLayers.length ? (
                <div
                  className="gerber-canvas"
                  style={gerberCanvasStyle}
                  dangerouslySetInnerHTML={{ __html: compositeSvg }}
                />
              ) : (
                <EmptyState icon={<Layers3 size={34} />} title="未载入 Gerber" />
              )}

              {scan ? (
                <img
                  className="scan-overlay"
                  src={scan.url}
                  alt={scan.name}
                  draggable={false}
                  decoding="async"
                  style={scanOverlayStyle}
                />
              ) : null}

              {showExtractionContent && extractionPreview ? (
                <img
                  className="extraction-main"
                  src={extractionPreview.url}
                  alt="scan extraction preview"
                  draggable={false}
                  decoding="async"
                />
              ) : null}

              {showAnalysisContent ? (
                <img
                  className="analysis-main"
                  src={analysis.heatmapUrl}
                  alt="analysis heatmap"
                  draggable={false}
                  decoding="async"
                />
              ) : null}
            </div>
            <svg className="calibration-overlay" style={{ opacity: showEditContent ? 1 : 0 }}>
              {gerberOverlayLine ? (
                <CalibrationLineOverlay line={gerberOverlayLine} kind="gerber" />
              ) : null}
              {scanOverlayLine ? (
                <CalibrationLineOverlay line={scanOverlayLine} kind="scan" />
              ) : null}
              {draftOverlayLine && lineDraft ? (
                <CalibrationLineOverlay line={draftOverlayLine} kind={lineDraft.target} draft />
              ) : null}
            </svg>
            {showAnalysisContent ? (
              <div className="analysis-legend">
                <span>
                  <i className="ok" /> 重合区域
                </span>
                <span>
                  <i className="miss" /> Gerber 未覆盖
                </span>
                <span>
                  <i className="extra" /> 扫描多出
                </span>
              </div>
            ) : null}
            {showExtractionContent ? (
              <div className="extraction-legend">
                <span>
                  <i /> 已提取区域
                </span>
                <span>
                  {extractionPreview
                    ? `${percent(extractionPreview.selectedPixels / Math.max(1, extractionPreview.totalPixels))}`
                    : '正在生成预览'}
                </span>
              </div>
            ) : null}
            <div className="shortcut-overlay" aria-label="快捷操作">
              {shortcutHints.map((hint) => (
                <span key={`${hint.key}-${hint.label}`}>
                  <kbd>{hint.key}</kbd>
                  {hint.label}
                </span>
              ))}
            </div>
          </div>

          <div className="heatmap-strip">
            {analysis ? (
              <img
                src={analysis.heatmapUrl}
                alt="analysis heatmap"
                draggable={false}
                decoding="async"
              />
            ) : (
              <div className="heatmap-placeholder">
                <ScanLine size={22} />
                <span>暂无偏差图</span>
              </div>
            )}
          </div>
        </section>

        <aside className="control-panel">
          <PanelTitle icon={<Crosshair size={18} />} title="配准" value={scan ? scan.name : '无'} />

          <div className="scan-list">
            {scanImages.length ? (
              scanImages.map((image) => {
                const match = matchLayersForScan(image.name, layers)
                const active = image.id === scan?.id
                return (
                  <button
                    type="button"
                    className={`scan-row ${active ? 'active' : ''}`}
                    key={image.id}
                    onClick={() => void selectScan(image)}
                  >
                    <strong>{image.name}</strong>
                    <span>{match.label}</span>
                  </button>
                )
              })
            ) : (
              <div className="scan-empty">未载入扫描图</div>
            )}
          </div>

          <div className="control-grid">
            <NumberControl
              label="X"
              value={alignment.offsetX}
              step={0.2}
              onChange={(value) => setAlignmentValue('offsetX', value)}
            />
            <NumberControl
              label="Y"
              value={alignment.offsetY}
              step={0.2}
              onChange={(value) => setAlignmentValue('offsetY', value)}
            />
            <NumberControl
              label="缩放"
              value={alignment.scale}
              step={0.002}
              min={0.1}
              onChange={(value) => setAlignmentValue('scale', value)}
            />
            <NumberControl
              label="角度"
              value={alignment.rotation}
              step={0.1}
              onChange={(value) => setAlignmentValue('rotation', value)}
            />
          </div>

          <div className="calibration-card">
            <PanelTitle
              icon={<Ruler size={18} />}
              title="划线配准"
              value={
                calibrationLines.gerber && calibrationLines.scan
                  ? '已就绪'
                  : calibrationMode
                    ? '绘制中'
                    : '待标定'
              }
            />
            <div className="line-actions">
              <button
                type="button"
                className={calibrationMode === 'gerber' ? 'active' : ''}
                onClick={() => beginLineCalibration('gerber')}
                disabled={!scan || !visibleLayers.length}
              >
                Gerber 线
              </button>
              <button
                type="button"
                className={calibrationMode === 'scan' ? 'active' : ''}
                onClick={() => beginLineCalibration('scan')}
                disabled={!scan || !visibleLayers.length}
              >
                扫描线
              </button>
            </div>
            <div className="line-state">
              <span>
                <i className="gerber-line" />
                Gerber {calibrationLines.gerber ? '已画' : '未画'}
              </span>
              <span>
                <i className="scan-line" />
                扫描 {calibrationLines.scan ? '已画' : '未画'}
              </span>
            </div>
            <div className="button-row compact">
              <button
                type="button"
                onClick={() => applyLineCalibration()}
                disabled={!calibrationLines.gerber || !calibrationLines.scan}
              >
                应用
              </button>
              <button type="button" onClick={clearLineCalibration}>
                清除
              </button>
            </div>
          </div>

          <SliderControl
            label="扫描透明度"
            value={alignment.scanOpacity}
            min={0.05}
            max={1}
            step={0.05}
            onChange={(value) => setAlignmentValue('scanOpacity', value)}
          />

          <div className="extraction-card">
            <PanelTitle
              icon={<WandSparkles size={18} />}
              title="扫描提取"
              value={viewMode === 'extract' ? '实时预览' : '用于分析'}
            />
            <div className="extract-mode-tabs">
              <button
                type="button"
                className={alignment.extraction.mode === 'key' ? 'active' : ''}
                onClick={() => setExtractionValue('mode', 'key')}
              >
                吸管抠图
              </button>
              <button
                type="button"
                className={alignment.extraction.mode === 'dark' ? 'active' : ''}
                onClick={() => setExtractionValue('mode', 'dark')}
              >
                暗色区域
              </button>
              <button
                type="button"
                className={alignment.extraction.mode === 'color' ? 'active' : ''}
                onClick={() => setExtractionValue('mode', 'color')}
              >
                色彩范围
              </button>
            </div>
            <button
              className="extract-preview-button"
              type="button"
              onClick={() => setViewMode('extract')}
              disabled={!scan}
            >
              查看提取预览
            </button>

            {alignment.extraction.mode === 'key' ? (
              <>
                <div className="eyedropper-row">
                  <button
                    type="button"
                    className={eyedropperActive ? 'active' : ''}
                    onClick={beginEyedropper}
                    disabled={!scan}
                  >
                    <Pipette size={15} />
                    吸管取色
                  </button>
                  <span
                    className="color-swatch large"
                    style={{
                      background: alignment.extraction.keyColor
                        ? colorToCss(alignment.extraction.keyColor)
                        : '#0f172a',
                    }}
                  />
                  <em>
                    {alignment.extraction.keyColor
                      ? colorToRgbLabel(alignment.extraction.keyColor)
                      : '未取样'}
                  </em>
                </div>
                <SliderControl
                  label="抠图容差"
                  value={alignment.extraction.keyTolerance}
                  min={4}
                  max={160}
                  step={1}
                  onChange={(value) => setExtractionValue('keyTolerance', value)}
                />
                <SliderControl
                  label="边缘柔化"
                  value={alignment.extraction.keySoftness}
                  min={1}
                  max={120}
                  step={1}
                  onChange={(value) => setExtractionValue('keySoftness', value)}
                />
                <SliderControl
                  label="色度权重"
                  value={alignment.extraction.keyChromaWeight}
                  min={0.1}
                  max={3}
                  step={0.05}
                  onChange={(value) => setExtractionValue('keyChromaWeight', value)}
                />
                <SliderControl
                  label="亮度权重"
                  value={alignment.extraction.keyLumaWeight}
                  min={0}
                  max={2}
                  step={0.05}
                  onChange={(value) => setExtractionValue('keyLumaWeight', value)}
                />
                <SliderControl
                  label="遮罩阈值"
                  value={alignment.extraction.keyMatteThreshold}
                  min={0.05}
                  max={0.95}
                  step={0.01}
                  onChange={(value) => setExtractionValue('keyMatteThreshold', value)}
                />
                <SliderControl
                  label="取样半径"
                  value={alignment.extraction.keySampleRadius}
                  min={0}
                  max={12}
                  step={1}
                  onChange={(value) => setExtractionValue('keySampleRadius', value)}
                />
              </>
            ) : null}

            {alignment.extraction.mode === 'dark' ? (
              <>
                <SliderControl
                  label="亮度阈值"
                  value={alignment.extraction.threshold}
                  min={0}
                  max={255}
                  step={1}
                  onChange={(value) => setExtractionValue('threshold', value)}
                />
                <SliderControl
                  label="最小色差"
                  value={alignment.extraction.minChroma}
                  min={0}
                  max={120}
                  step={1}
                  onChange={(value) => setExtractionValue('minChroma', value)}
                />
                <SliderControl
                  label="绿区排除强度"
                  value={alignment.extraction.greenDominance}
                  min={1}
                  max={1.5}
                  step={0.01}
                  onChange={(value) => setExtractionValue('greenDominance', value)}
                />
              </>
            ) : null}

            {alignment.extraction.mode === 'color' ? (
              <>
                <SliderControl
                  label="最小色差"
                  value={alignment.extraction.minChroma}
                  min={0}
                  max={120}
                  step={1}
                  onChange={(value) => setExtractionValue('minChroma', value)}
                />
                <SliderControl
                  label="色相最小"
                  value={alignment.extraction.hueMin}
                  min={0}
                  max={360}
                  step={1}
                  onChange={(value) => setExtractionValue('hueMin', value)}
                />
                <SliderControl
                  label="色相最大"
                  value={alignment.extraction.hueMax}
                  min={0}
                  max={360}
                  step={1}
                  onChange={(value) => setExtractionValue('hueMax', value)}
                />
                <SliderControl
                  label="饱和度最小"
                  value={alignment.extraction.minSaturation}
                  min={0}
                  max={100}
                  step={1}
                  onChange={(value) => setExtractionValue('minSaturation', value)}
                />
                <SliderControl
                  label="饱和度最大"
                  value={alignment.extraction.maxSaturation}
                  min={0}
                  max={100}
                  step={1}
                  onChange={(value) => setExtractionValue('maxSaturation', value)}
                />
                <SliderControl
                  label="亮度最小"
                  value={alignment.extraction.minLightness}
                  min={0}
                  max={100}
                  step={1}
                  onChange={(value) => setExtractionValue('minLightness', value)}
                />
                <SliderControl
                  label="亮度最大"
                  value={alignment.extraction.maxLightness}
                  min={0}
                  max={100}
                  step={1}
                  onChange={(value) => setExtractionValue('maxLightness', value)}
                />
              </>
            ) : null}

            <div className="extract-switches">
              {alignment.extraction.mode === 'dark' ? (
                <label>
                  <input
                    type="checkbox"
                    checked={alignment.extraction.adaptive}
                    onChange={(event) => setExtractionValue('adaptive', event.target.checked)}
                  />
                  自适应阈值
                </label>
              ) : null}
              <label>
                <input
                  type="checkbox"
                  checked={alignment.extraction.invert}
                  onChange={(event) => setExtractionValue('invert', event.target.checked)}
                />
                反相
              </label>
              {alignment.extraction.mode === 'dark' ? (
                <label>
                  <input
                    type="checkbox"
                    checked={alignment.extraction.rejectGreen}
                    onChange={(event) => setExtractionValue('rejectGreen', event.target.checked)}
                  />
                  排除绿区
                </label>
              ) : null}
            </div>
            <SliderControl
              label="去噪强度"
              value={alignment.extraction.denoise}
              min={0}
              max={8}
              step={1}
              onChange={(value) => setExtractionValue('denoise', value)}
            />
            <SliderControl
              label="区域膨胀"
              value={alignment.extraction.grow}
              min={0}
              max={4}
              step={1}
              onChange={(value) => setExtractionValue('grow', value)}
            />
            <div className="button-row compact">
              <button type="button" onClick={resetExtractionSettings}>
                重置提取
              </button>
            </div>
          </div>

          <div className="button-row">
            <button type="button" onClick={() => commitAlignment(INITIAL_ALIGNMENT)}>
              <RotateCcw size={16} />
              重置
            </button>
            <button type="button" onClick={() => void runAutoAlign()} disabled={!scan || busy}>
              <Crosshair size={16} />
              自动对齐
            </button>
          </div>

          <PanelTitle icon={<Activity size={18} />} title="结果" value={analysis ? '已计算' : '待分析'} />

          <div className="metric-grid">
            <Metric label="偏差率" value={analysis ? percent(analysis.mismatchRatio) : '--'} />
            <Metric label="覆盖率" value={analysis ? percent(analysis.coverageRatio) : '--'} />
            <Metric
              label="X 质心"
              value={analysis ? `${analysis.centroidDeltaX.toFixed(1)} px` : '--'}
            />
            <Metric
              label="Y 质心"
              value={analysis ? `${analysis.centroidDeltaY.toFixed(1)} px` : '--'}
            />
          </div>

          <div className="scan-card">
            {scan ? (
              <>
                <strong>{scan.name}</strong>
                <span>
                  {scan.width} x {scan.height} px
                </span>
                <span>组合：{activeMatch?.label ?? '未匹配线路层'}</span>
              </>
            ) : (
              <span>未载入扫描图</span>
            )}
          </div>
        </aside>
      </section>

      {busyMessage ? (
        <div className="busy-modal" role="status" aria-live="polite" aria-label="正在处理">
          <div className="busy-card">
            <Loader2 size={28} className="spin" />
            <strong>{busyMessage}</strong>
            <span>文件较多时需要等待一会，请不要重复点击导入按钮。</span>
          </div>
        </div>
      ) : null}

      {manualOpen ? (
        <div className="manual-modal" role="dialog" aria-modal="true" aria-label="软件说明书">
          <div className="manual-dialog">
            <div className="manual-header">
              <span>
                <BookOpen size={18} />
                软件说明书
                <em>Esc 关闭</em>
              </span>
              <button type="button" onClick={() => setManualOpen(false)} aria-label="关闭说明书">
                <X size={18} />
              </button>
            </div>
            <iframe className="manual-frame" title="PCB Gerber Aligner 使用说明书" src="./manual.html" />
          </div>
        </div>
      ) : null}
    </main>
  )
}

function getImageId(file: File) {
  return `${file.name}-${file.size}-${file.lastModified}`
}

async function loadScanImage(file: File): Promise<ScanImage> {
  const url = URL.createObjectURL(file)
  try {
    const image = await loadImage(url)
    return {
      id: getImageId(file),
      name: file.name,
      url,
      width: image.naturalWidth,
      height: image.naturalHeight,
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

async function loadBrowserScanImages(files: File[]) {
  const loaded: ScanImage[] = []

  try {
    for (const file of files) {
      loaded.push(await loadScanImage(file))
    }
    return loaded
  } catch (error) {
    revokeScanImageUrls(loaded)
    throw error
  }
}

function colorToCss(color: ScanExtractionColor) {
  return `rgb(${color.red} ${color.green} ${color.blue})`
}

function colorToRgbLabel(color: ScanExtractionColor) {
  return `RGB ${color.red}, ${color.green}, ${color.blue}`
}

async function sampleScanColorAtStagePoint(
  scan: ScanImage,
  alignment: AlignmentState,
  stageSize: StageSize,
  stagePoint: StagePoint,
  sampleRadius: number,
): Promise<ScanExtractionColor | null> {
  const basePoint = invertScanPoint(stagePoint, alignment, stageSize)
  const imageRect = containScanImageRect(scan, stageSize)
  if (
    basePoint.x < imageRect.x ||
    basePoint.y < imageRect.y ||
    basePoint.x > imageRect.x + imageRect.width ||
    basePoint.y > imageRect.y + imageRect.height
  ) {
    return null
  }

  const imageX = clamp(
    Math.round(((basePoint.x - imageRect.x) / imageRect.width) * scan.width),
    0,
    scan.width - 1,
  )
  const imageY = clamp(
    Math.round(((basePoint.y - imageRect.y) / imageRect.height) * scan.height),
    0,
    scan.height - 1,
  )
  const radius = Math.max(0, Math.round(sampleRadius))
  const startX = clamp(imageX - radius, 0, scan.width - 1)
  const startY = clamp(imageY - radius, 0, scan.height - 1)
  const endX = clamp(imageX + radius, 0, scan.width - 1)
  const endY = clamp(imageY + radius, 0, scan.height - 1)
  const width = endX - startX + 1
  const height = endY - startY + 1
  const image = await loadImage(scan.url)
  const canvas = document.createElement('canvas')
  canvas.width = scan.width
  canvas.height = scan.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas 2D is not available')

  context.drawImage(image, 0, 0, scan.width, scan.height)
  const data = context.getImageData(startX, startY, width, height).data
  let red = 0
  let green = 0
  let blue = 0
  let pixels = 0

  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3]
    if (alpha < 16) continue
    red += data[offset]
    green += data[offset + 1]
    blue += data[offset + 2]
    pixels += 1
  }

  if (!pixels) return null
  return {
    red: Math.round(red / pixels),
    green: Math.round(green / pixels),
    blue: Math.round(blue / pixels),
  }
}

function containScanImageRect(scan: ScanImage, stageSize: StageSize) {
  const fit = Math.min(stageSize.width / scan.width, stageSize.height / scan.height)
  const width = scan.width * fit
  const height = scan.height * fit
  return {
    x: (stageSize.width - width) / 2,
    y: (stageSize.height - height) / 2,
    width,
    height,
  }
}

function PanelTitle({
  icon,
  title,
  value,
}: {
  icon: ReactNode
  title: string
  value: string
}) {
  return (
    <div className="panel-title">
      <span>
        {icon}
        {title}
      </span>
      <em>{value}</em>
    </div>
  )
}

function NumberControl({
  label,
  value,
  step,
  min,
  onChange,
}: {
  label: string
  value: number
  step: number
  min?: number
  onChange: (value: number) => void
}) {
  return (
    <label className="number-control">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

function SliderControl({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}) {
  return (
    <label className="slider-control">
      <span>
        {label}
        <em>{Number.isInteger(value) ? value : value.toFixed(2)}</em>
      </span>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function EmptyState({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="empty-state">
      {icon}
      <span>{title}</span>
    </div>
  )
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span className="brand-mark-board" />
      <span className="brand-mark-scan" />
      <span className="brand-mark-dot one" />
      <span className="brand-mark-dot two" />
      <span className="brand-mark-dot three" />
    </span>
  )
}

function CalibrationLineOverlay({
  line,
  kind,
  draft = false,
}: {
  line: CalibrationLine
  kind: CalibrationTarget
  draft?: boolean
}) {
  const dash = draft ? '6 4' : undefined

  return (
    <g className={`calibration-mark ${kind} ${draft ? 'draft' : ''}`}>
      <line
        className="aim-line"
        x1={line.start.x}
        y1={line.start.y}
        x2={line.end.x}
        y2={line.end.y}
        strokeWidth={1}
        strokeDasharray={dash}
      />
      <CalibrationEndpointMarker point={line.start} />
      <CalibrationEndpointMarker point={line.end} />
    </g>
  )
}

function CalibrationEndpointMarker({ point }: { point: StagePoint }) {
  const outer = 8
  const gap = 2
  const tick = 2.5
  const markerLines: Array<[number, number, number, number]> = [
    [point.x - outer, point.y, point.x - gap, point.y],
    [point.x + gap, point.y, point.x + outer, point.y],
    [point.x, point.y - outer, point.x, point.y - gap],
    [point.x, point.y + gap, point.x, point.y + outer],
    [point.x - outer, point.y - tick, point.x - outer, point.y + tick],
    [point.x + outer, point.y - tick, point.x + outer, point.y + tick],
    [point.x - tick, point.y - outer, point.x + tick, point.y - outer],
    [point.x - tick, point.y + outer, point.x + tick, point.y + outer],
  ]

  return (
    <g className="aim-marker">
      {markerLines.map(([x1, y1, x2, y2], index) => (
        <line
          key={index}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          strokeWidth={1}
        />
      ))}
    </g>
  )
}

function updateDraggedLine(
  lines: CalibrationLines,
  drag: LineDrag,
  point: StagePoint,
  alignment: AlignmentState,
  stageSize: { width: number; height: number },
): CalibrationLines {
  if (drag.target === 'gerber' && lines.gerber) {
    return {
      ...lines,
      gerber: updateLineInStage(lines.gerber, drag, point),
    }
  }

  if (drag.target === 'scan' && lines.scan) {
    const displayLine = transformScanLine(lines.scan, alignment, stageSize)
    return {
      ...lines,
      scan: invertScanLine(updateLineInStage(displayLine, drag, point), alignment, stageSize),
    }
  }

  return lines
}

function updateLineInStage(line: CalibrationLine, drag: LineDrag, point: StagePoint): CalibrationLine {
  if (drag.handle === 'start') return { ...line, start: point }
  if (drag.handle === 'end') return { ...line, end: point }

  const delta = {
    x: point.x - drag.previousPoint.x,
    y: point.y - drag.previousPoint.y,
  }
  return {
    start: addPoint(line.start, delta),
    end: addPoint(line.end, delta),
  }
}

function calculateLineAlignment(
  gerberLine: CalibrationLine,
  scanLine: CalibrationLine,
  stageSize: { width: number; height: number },
  currentAlignment: AlignmentState,
): AlignmentState | null {
  const gerberLength = distance(gerberLine.start, gerberLine.end)
  const scanLength = distance(scanLine.start, scanLine.end)
  if (gerberLength < 12 || scanLength < 12) return null

  const scale = clamp(gerberLength / scanLength, 0.1, 10)
  const gerberAngle = lineAngle(gerberLine)
  const gerberMid = midpoint(gerberLine)

  const candidates = [scanLine, reverseLine(scanLine)]
    .map((candidate) => {
      const rotation = normalizeDegrees(radiansToDegrees(gerberAngle - lineAngle(candidate)))
      const projectedMid = transformScanPoint(
        midpoint(candidate),
        {
          ...currentAlignment,
          offsetX: 0,
          offsetY: 0,
          scale,
          rotation,
        },
        stageSize,
      )

      return {
        alignment: {
          ...currentAlignment,
          offsetX: roundNumber(gerberMid.x - projectedMid.x, 3),
          offsetY: roundNumber(gerberMid.y - projectedMid.y, 3),
          scale: roundNumber(scale, 4),
          rotation: roundNumber(rotation, 3),
        },
        rotationDelta: Math.abs(normalizeDegrees(rotation - currentAlignment.rotation)),
      }
    })
    .sort((a, b) => a.rotationDelta - b.rotationDelta)

  return candidates[0]?.alignment ?? null
}

function invertScanLine(
  line: CalibrationLine,
  alignment: AlignmentState,
  stageSize: { width: number; height: number },
): CalibrationLine {
  return {
    start: invertScanPoint(line.start, alignment, stageSize),
    end: invertScanPoint(line.end, alignment, stageSize),
  }
}

function transformScanLine(
  line: CalibrationLine,
  alignment: AlignmentState,
  stageSize: { width: number; height: number },
): CalibrationLine {
  return {
    start: transformScanPoint(line.start, alignment, stageSize),
    end: transformScanPoint(line.end, alignment, stageSize),
  }
}

function stageLineToScreenLine(
  line: CalibrationLine,
  currentViewport: ViewportState,
  stageSize: { width: number; height: number },
): CalibrationLine {
  return {
    start: stagePointToScreenPoint(line.start, currentViewport, stageSize),
    end: stagePointToScreenPoint(line.end, currentViewport, stageSize),
  }
}

function stagePointToScreenPoint(
  point: StagePoint,
  currentViewport: ViewportState,
  stageSize: { width: number; height: number },
): StagePoint {
  const centerX = stageSize.width / 2
  const centerY = stageSize.height / 2
  return {
    x: centerX + currentViewport.x + (point.x - centerX) * currentViewport.scale,
    y: centerY + currentViewport.y + (point.y - centerY) * currentViewport.scale,
  }
}

function invertScanPoint(
  point: StagePoint,
  alignment: AlignmentState,
  stageSize: { width: number; height: number },
): StagePoint {
  const centerX = stageSize.width / 2
  const centerY = stageSize.height / 2
  const rotated = rotateVector(
    point.x - centerX - alignment.offsetX,
    point.y - centerY - alignment.offsetY,
    degreesToRadians(-alignment.rotation),
  )
  const scale = Math.max(0.0001, alignment.scale)
  return {
    x: centerX + rotated.x / scale,
    y: centerY + rotated.y / scale,
  }
}

function transformScanPoint(
  point: StagePoint,
  alignment: AlignmentState,
  stageSize: { width: number; height: number },
): StagePoint {
  const centerX = stageSize.width / 2
  const centerY = stageSize.height / 2
  const rotated = rotateVector(
    (point.x - centerX) * alignment.scale,
    (point.y - centerY) * alignment.scale,
    degreesToRadians(alignment.rotation),
  )
  return {
    x: centerX + alignment.offsetX + rotated.x,
    y: centerY + alignment.offsetY + rotated.y,
  }
}

function rotateVector(x: number, y: number, radians: number) {
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    x: x * cos - y * sin,
    y: x * sin + y * cos,
  }
}

function reverseLine(line: CalibrationLine): CalibrationLine {
  return { start: line.end, end: line.start }
}

function midpoint(line: CalibrationLine): StagePoint {
  return {
    x: (line.start.x + line.end.x) / 2,
    y: (line.start.y + line.end.y) / 2,
  }
}

function addPoint(point: StagePoint, delta: StagePoint): StagePoint {
  return {
    x: point.x + delta.x,
    y: point.y + delta.y,
  }
}

function distance(start: StagePoint, end: StagePoint) {
  return Math.hypot(end.x - start.x, end.y - start.y)
}

function distanceToSegment(point: StagePoint, start: StagePoint, end: StagePoint) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= 0.0001) return distance(point, start)

  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1)
  return distance(point, {
    x: start.x + dx * t,
    y: start.y + dy * t,
  })
}

function lineAngle(line: CalibrationLine) {
  return Math.atan2(line.end.y - line.start.y, line.end.x - line.start.x)
}

function degreesToRadians(value: number) {
  return (value * Math.PI) / 180
}

function radiansToDegrees(value: number) {
  return (value * 180) / Math.PI
}

function normalizeDegrees(value: number) {
  return ((((value + 180) % 360) + 360) % 360) - 180
}

function roundNumber(value: number, digits: number) {
  return Number(value.toFixed(digits))
}

function getCalibrationKey(scan: ScanImage) {
  return scan.id
}

function normalizeAlignment(
  alignment: Partial<AlignmentState> & { threshold?: unknown; invertScan?: unknown },
): AlignmentState {
  const legacyThreshold =
    typeof alignment.threshold === 'number' ? alignment.threshold : INITIAL_EXTRACTION.threshold
  const legacyInvert =
    typeof alignment.invertScan === 'boolean' ? alignment.invertScan : INITIAL_EXTRACTION.invert
  const rawExtraction =
    alignment.extraction && typeof alignment.extraction === 'object'
      ? (alignment.extraction as Partial<ScanExtractionSettings>)
      : {}

  return {
    ...INITIAL_ALIGNMENT,
    ...alignment,
    extraction: {
      ...INITIAL_EXTRACTION,
      threshold: legacyThreshold,
      invert: legacyInvert,
      ...rawExtraction,
    },
  }
}

function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve())
    })
  })
}

function buildShortcutHints({
  activeLineTarget,
  editLayerFocus,
  eyedropperActive,
  hasScan,
  hasVisibleLayers,
  lineDraftActive,
  lineDragActive,
  viewMode,
}: {
  activeLineTarget: CalibrationTarget | null
  editLayerFocus: EditLayerFocus
  eyedropperActive: boolean
  hasScan: boolean
  hasVisibleLayers: boolean
  lineDraftActive: boolean
  lineDragActive: boolean
  viewMode: ViewMode
}) {
  const hints = [
    { key: '滚轮', label: '缩放' },
    { key: '拖动', label: activeLineTarget ? '绘制/调整线' : '平移' },
    { key: '双击', label: '复位视图' },
  ]

  if (viewMode === 'analysis') {
    hints.push({ key: 'Esc', label: '返回编辑' })
    return hints
  }

  if (viewMode === 'extract') {
    if (eyedropperActive) {
      hints.push({ key: '点击', label: '吸管取色' })
      hints.push({ key: 'Esc', label: '取消吸管' })
      return hints
    }
    hints.push({ key: '分析', label: '比较 Gerber' })
    if (hasScan) hints.push({ key: '吸管', label: '点击取色' })
    hints.push({ key: 'Esc', label: '返回编辑' })
    return hints
  }

  if (activeLineTarget || lineDraftActive || lineDragActive) {
    hints.push({ key: 'Esc', label: '取消划线' })
    return hints
  }

  if (editLayerFocus) {
    hints.push({ key: 'Esc', label: '恢复叠加' })
  }

  if (hasScan && hasVisibleLayers) {
    hints.push({ key: 'V', label: editLayerFocus ? '切换单图' : '单图显示' })
  }

  return hints
}

function loadStoredString(key: string) {
  try {
    return window.localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function persistStoredString(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Directory memory is a convenience feature; import still works without storage.
  }
}

function hasTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function isImageImport(name: string, mimeType: string) {
  if (mimeType.startsWith('image/')) return true
  return /\.(png|jpe?g|bmp|tiff?|webp)$/i.test(name)
}

async function loadImportedScanImages(files: ImportedScanFile[]) {
  const loaded: ScanImage[] = []

  try {
    for (const file of files) {
      loaded.push(await loadImportedScanImage(file))
    }
    return loaded
  } catch (error) {
    revokeScanImageUrls(loaded)
    throw error
  }
}

async function loadImportedScanImage(file: ImportedScanFile): Promise<ScanImage> {
  const url = URL.createObjectURL(base64ToBlob(file.bytesBase64, file.mimeType))

  try {
    const image = await loadImage(url)
    return {
      id: `${file.path}-${file.size}-${file.modifiedMs}`,
      name: file.name,
      url,
      width: image.naturalWidth,
      height: image.naturalHeight,
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

function base64ToBlob(bytesBase64: string, mimeType: string) {
  const binary = atob(bytesBase64)
  const chunks: BlobPart[] = []

  for (let offset = 0; offset < binary.length; offset += 8192) {
    const slice = binary.slice(offset, offset + 8192)
    const bytes = new Uint8Array(slice.length)
    for (let index = 0; index < slice.length; index += 1) {
      bytes[index] = slice.charCodeAt(index)
    }
    chunks.push(bytes)
  }

  return new Blob(chunks, { type: mimeType })
}

function revokeScanImageUrls(images: ScanImage[]) {
  for (const image of images) {
    if (image.url.startsWith('blob:')) URL.revokeObjectURL(image.url)
  }
}

function compactPath(path: string) {
  const normalized = path.replaceAll('\\', '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 2) return path
  return `.../${parts.slice(-2).join('/')}`
}

function loadStoredCalibrations(): StoredCalibrationMap {
  try {
    const raw = window.localStorage.getItem(CALIBRATION_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as StoredCalibrationMap)
      : {}
  } catch {
    return {}
  }
}

function persistStoredCalibrations(store: StoredCalibrationMap) {
  try {
    window.localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // localStorage can be unavailable or full; the in-memory calibration still remains active.
  }
}

function cloneCalibrationLines(lines: CalibrationLines): CalibrationLines {
  return {
    gerber: lines.gerber ? cloneCalibrationLine(lines.gerber) : null,
    scan: lines.scan ? cloneCalibrationLine(lines.scan) : null,
  }
}

function cloneCalibrationLine(line: CalibrationLine): CalibrationLine {
  return {
    start: { ...line.start },
    end: { ...line.end },
  }
}

function viewportTransform(currentViewport: ViewportState) {
  return `translate3d(${currentViewport.x}px, ${currentViewport.y}px, 0) scale(${currentViewport.scale})`
}

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName)
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片读取失败'))
    image.src = url
  })
}

function percent(value: number) {
  return `${(value * 100).toFixed(2)}%`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export default App
