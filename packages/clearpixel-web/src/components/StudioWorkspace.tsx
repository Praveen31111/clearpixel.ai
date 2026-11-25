'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Undo2,
  Redo2,
  FilePlus2,
  Download,
  ChevronDown,
  ChevronUp,
  Crop,
  Droplet,
  Wand2,
  Settings,
  ZoomIn,
  Maximize2,
  Sun,
  Moon,
  Image as ImageIcon,
  Eraser,
  Paintbrush,
  MoveHorizontal,
  Zap,
  Hand,
  ZoomOut,
  User,
  Package,
} from 'lucide-react';
import { Logo } from './Logo';
import type { SubjectMode } from '@/lib/edge-refiner';
import {
  BackgroundMode,
  BackgroundSettings,
  ExportFormat,
  LeftRailTab,
  ProcessingState,
  RefineSettings,
  StudioImage,
} from '@/types/studio';

interface StudioWorkspaceProps {
  image: StudioImage;
  processing: ProcessingState;
  darkMode: boolean;
  subjectMode: SubjectMode;
  onChangeSubjectMode: (mode: SubjectMode) => void;
  onToggleDark: () => void;
  onReprocessUltra?: () => void;
  onReset: () => void;
}

const SOLID_SWATCHES = ['#FFFFFF', '#09090B', '#F4F4F5', '#2563EB', '#EF4444', '#10B981', '#F59E0B'];
const GRADIENT_SWATCHES = [
  'linear-gradient(135deg, #2563EB 0%, #60A5FA 100%)',
  'linear-gradient(135deg, #09090B 0%, #3F3F46 100%)',
  'linear-gradient(135deg, #F59E0B 0%, #EF4444 100%)',
  'linear-gradient(135deg, #10B981 0%, #06B6D4 100%)',
];

export function StudioWorkspace({
  image,
  processing,
  darkMode,
  subjectMode,
  onChangeSubjectMode,
  onToggleDark,
  onReprocessUltra,
  onReset,
}: StudioWorkspaceProps) {
  const [splitPos, setSplitPos] = useState(50);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const [interactionMode, setInteractionMode] = useState<'split' | 'brush' | 'pan'>('split');
  const [isPainting, setIsPainting] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(100);
  const [holdOriginal, setHoldOriginal] = useState(false);
  const [leftTab, setLeftTab] = useState<LeftRailTab>('canvas');
  const [mobileSheet, setMobileSheet] = useState<'background' | 'brush'>('background');
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [bgOpen, setBgOpen] = useState(true);
  const [refineOpen, setRefineOpen] = useState(true);
  const [historyState, setHistoryState] = useState({ index: -1, length: 0 });

  const [bgSettings, setBgSettings] = useState<BackgroundSettings>({
    mode: 'transparent',
    solidColor: '#FFFFFF',
    gradientCss: GRADIENT_SWATCHES[0],
    customPhotoUrl: null,
    blurPx: 0,
  });

  const [refineSettings, setRefineSettings] = useState<RefineSettings>({
    tool: 'keep',
    brushSize: 30,
    feather: 5,
  });
  const [defringe, setDefringe] = useState(0);

  const stageRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const cutoutCanvasRef = useRef<HTMLCanvasElement>(null);
  const baseCutoutDataRef = useRef<ImageData | null>(null);
  const defringeRafRef = useRef<number | null>(null);
  const originalImgRef = useRef<HTMLImageElement | null>(null);
  const historyRef = useRef<ImageData[]>([]);
  const historyIdxRef = useRef(-1);
  const lastBrushPtRef = useRef<{ x: number; y: number } | null>(null);
  const bgPhotoInputRef = useRef<HTMLInputElement>(null);

  // Sync live cutout canvas and original image ref whenever image.cutoutUrl updates
  useEffect(() => {
    let cancelled = false;
    Promise.all([loadImg(image.cutoutUrl), loadImg(image.originalUrl)]).then(
      ([cutImg, origImg]) => {
        if (cancelled) return;
        originalImgRef.current = origImg;
        const canvas = cutoutCanvasRef.current;
        if (!canvas) return;
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(cutImg, 0, 0, canvas.width, canvas.height);

        const initial = ctx.getImageData(0, 0, canvas.width, canvas.height);
        baseCutoutDataRef.current = initial;
        setDefringe(0);
        historyRef.current = [initial];
        historyIdxRef.current = 0;
        setHistoryState({ index: 0, length: 1 });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [image.cutoutUrl, image.originalUrl, image.width, image.height]);

  // Real-time 60fps Defringe pass to tighten residual white/black hair halos
  const handleDefringeChange = useCallback((level: number) => {
    setDefringe(level);
    if (defringeRafRef.current) cancelAnimationFrame(defringeRafRef.current);
    defringeRafRef.current = requestAnimationFrame(() => {
      const base = baseCutoutDataRef.current;
      const canvas = cutoutCanvasRef.current;
      const ctx = canvas?.getContext('2d', { willReadFrequently: true });
      if (!base || !canvas || !ctx) return;

      if (level === 0) {
        ctx.putImageData(base, 0, 0);
        return;
      }

      const src = base.data;
      const next = new ImageData(base.width, base.height);
      const dst = next.data;
      const erode = level * 1.15;
      const scale = 1 / Math.max(0.25, 1 - level * 0.0045);

      for (let i = 0; i < src.length; i += 4) {
        const a = src[i + 3];
        if (a === 0) continue;
        if (a >= 250) {
          dst[i] = src[i];
          dst[i + 1] = src[i + 1];
          dst[i + 2] = src[i + 2];
          dst[i + 3] = 255;
          continue;
        }
        const newA = Math.max(0, Math.min(255, Math.round((a - erode) * scale)));
        if (newA === 0) continue;
        dst[i] = src[i];
        dst[i + 1] = src[i + 1];
        dst[i + 2] = src[i + 2];
        dst[i + 3] = newA;
      }

      ctx.putImageData(next, 0, 0);
    });
  }, []);

  const handleUndo = useCallback(() => {
    const canvas = cutoutCanvasRef.current;
    const ctx = canvas?.getContext('2d', { willReadFrequently: true });
    if (!ctx || historyIdxRef.current <= 0) return;
    historyIdxRef.current -= 1;
    ctx.putImageData(historyRef.current[historyIdxRef.current], 0, 0);
    setHistoryState({ index: historyIdxRef.current, length: historyRef.current.length });
  }, []);

  const handleRedo = useCallback(() => {
    const canvas = cutoutCanvasRef.current;
    const ctx = canvas?.getContext('2d', { willReadFrequently: true });
    if (!ctx || historyIdxRef.current >= historyRef.current.length - 1) return;
    historyIdxRef.current += 1;
    ctx.putImageData(historyRef.current[historyIdxRef.current], 0, 0);
    setHistoryState({ index: historyIdxRef.current, length: historyRef.current.length });
  }, []);

  // Keyboard shortcuts: Hold Space (Original), Ctrl+Z (Undo), Ctrl+Y (Redo)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        setHoldOriginal(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setHoldOriginal(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [handleUndo, handleRedo]);

  // Convert pointer event to exact image pixel coordinates (accounting for object-contain letterboxing)
  const clientToImageCoords = useCallback(
    (clientX: number, clientY: number) => {
      const stage = stageRef.current;
      if (!stage) return null;
      const rect = stage.getBoundingClientRect();
      const stageAspect = rect.width / rect.height;
      const imgAspect = image.width / image.height;

      let drawW = rect.width;
      let drawH = rect.height;
      let offsetX = 0;
      let offsetY = 0;

      if (imgAspect > stageAspect) {
        drawH = rect.width / imgAspect;
        offsetY = (rect.height - drawH) / 2;
      } else {
        drawW = rect.height * imgAspect;
        offsetX = (rect.width - drawW) / 2;
      }

      const x = ((clientX - rect.left - offsetX) / drawW) * image.width;
      const y = ((clientY - rect.top - offsetY) / drawH) * image.height;
      return { x, y, scaleRatio: image.width / drawW };
    },
    [image.width, image.height]
  );

  const paintBrushAt = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = cutoutCanvasRef.current;
      const ctx = canvas?.getContext('2d', { willReadFrequently: true });
      const pt = clientToImageCoords(clientX, clientY);
      if (!canvas || !ctx || !pt) return;

      const radius = Math.max(2, (refineSettings.brushSize * pt.scaleRatio) / 2);
      const featherFrac = Math.min(0.95, refineSettings.feather / 22);
      const innerR = radius * (1 - featherFrac);

      const paintDot = (cx: number, cy: number) => {
        if (refineSettings.tool === 'erase') {
          ctx.save();
          ctx.globalCompositeOperation = 'destination-out';
          const grad = ctx.createRadialGradient(cx, cy, innerR, cx, cy, radius);
          grad.addColorStop(0, 'rgba(0,0,0,1)');
          grad.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else if (originalImgRef.current) {
          // Keep brush: restore soft circular patch from original image
          const size = Math.ceil(radius * 2) + 2;
          const patch = document.createElement('canvas');
          patch.width = size;
          patch.height = size;
          const pCtx = patch.getContext('2d');
          if (!pCtx) return;

          const sx = cx - radius;
          const sy = cy - radius;
          pCtx.drawImage(originalImgRef.current, -sx, -sy, image.width, image.height);
          pCtx.globalCompositeOperation = 'destination-in';
          const grad = pCtx.createRadialGradient(radius, radius, innerR, radius, radius, radius);
          grad.addColorStop(0, 'rgba(0,0,0,1)');
          grad.addColorStop(1, 'rgba(0,0,0,0)');
          pCtx.fillStyle = grad;
          pCtx.beginPath();
          pCtx.arc(radius, radius, radius, 0, Math.PI * 2);
          pCtx.fill();

          ctx.drawImage(patch, sx, sy);
        }
      };

      const prev = lastBrushPtRef.current;
      if (prev) {
        const dx = pt.x - prev.x;
        const dy = pt.y - prev.y;
        const dist = Math.hypot(dx, dy);
        const step = Math.max(2, radius * 0.3);
        const steps = Math.ceil(dist / step);
        for (let s = 1; s <= steps; s++) {
          paintDot(prev.x + (dx * s) / steps, prev.y + (dy * s) / steps);
        }
      } else {
        paintDot(pt.x, pt.y);
      }
      lastBrushPtRef.current = { x: pt.x, y: pt.y };
    },
    [clientToImageCoords, image.width, image.height, refineSettings]
  );

  const commitBrushStroke = useCallback(() => {
    const canvas = cutoutCanvasRef.current;
    const ctx = canvas?.getContext('2d', { willReadFrequently: true });
    if (!canvas || !ctx) return;
    const snap = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const nextHistory = historyRef.current.slice(0, historyIdxRef.current + 1);
    nextHistory.push(snap);
    if (nextHistory.length > 15) nextHistory.shift();
    historyRef.current = nextHistory;
    historyIdxRef.current = nextHistory.length - 1;
    setHistoryState({ index: historyIdxRef.current, length: nextHistory.length });
  }, []);

  const updateSplitFromClientX = useCallback((clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const pct = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
    setSplitPos(pct);
  }, []);

  // Non-passive wheel zoom so browser never logs passive preventDefault warning
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaY) > 0) {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 25 : -25;
        setZoom((z) => Math.min(800, Math.max(25, z + delta)));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    if (!isDraggingSplit) return;
    const onMove = (e: PointerEvent) => updateSplitFromClientX(e.clientX);
    const onUp = () => setIsDraggingSplit(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [isDraggingSplit, updateSplitFromClientX]);

  // Real client-side full-resolution canvas export (includes manual Keep/Erase edits)
  const handleExport = async (format: ExportFormat) => {
    setShowExportMenu(false);
    const baseName = image.name.replace(/\.[^/.]+$/, '');

    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. Paint background if not transparent (or if JPEG)
    if (bgSettings.mode === 'solid' || (format === 'jpeg' && bgSettings.mode === 'transparent')) {
      ctx.fillStyle = bgSettings.mode === 'solid' ? bgSettings.solidColor : '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else if (bgSettings.mode === 'gradient') {
      const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      grad.addColorStop(0, '#2563EB');
      grad.addColorStop(1, '#60A5FA');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else if (bgSettings.mode === 'photo' && bgSettings.customPhotoUrl) {
      const bgImg = await loadImg(bgSettings.customPhotoUrl);
      if (bgSettings.blurPx > 0) ctx.filter = `blur(${bgSettings.blurPx}px)`;
      ctx.drawImage(bgImg, 0, 0, canvas.width, canvas.height);
      ctx.filter = 'none';
    }

    // 2. Draw live edited cutout canvas (falls back to cutoutUrl if canvas not mounted)
    if (cutoutCanvasRef.current && cutoutCanvasRef.current.width > 0) {
      ctx.drawImage(cutoutCanvasRef.current, 0, 0, canvas.width, canvas.height);
    } else {
      const fgImg = await loadImg(image.cutoutUrl);
      ctx.drawImage(fgImg, 0, 0, canvas.width, canvas.height);
    }

    const mime =
      format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';
    const dataUrl = canvas.toDataURL(mime, 0.95);
    const link = document.createElement('a');
    link.download = `${baseName}-clearpixel.${format}`;
    link.href = dataUrl;
    link.click();
  };

  const renderBackgroundStyle = (): React.CSSProperties => {
    if (bgSettings.mode === 'solid') return { backgroundColor: bgSettings.solidColor };
    if (bgSettings.mode === 'gradient') return { background: bgSettings.gradientCss };
    if (bgSettings.mode === 'photo' && bgSettings.customPhotoUrl) {
      return {
        backgroundImage: `url(${bgSettings.customPhotoUrl})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        filter: bgSettings.blurPx > 0 ? `blur(${bgSettings.blurPx}px)` : undefined,
      };
    }
    return {};
  };

  return (
    <div className="h-dvh flex flex-col bg-[#F4F4F5] dark:bg-[#09090B] overflow-hidden select-none">
      {/* Top Studio Header (Desktop 56px / Mobile 48px) */}
      <header className="relative h-12 md:h-14 shrink-0 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 md:px-4 flex items-center justify-between gap-2 z-30">
        {processing.isProcessing && (
          <div className="absolute bottom-0 left-0 right-0 h-[2.5px] bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all duration-200 ease-out"
              style={{ width: `${Math.max(8, processing.progress)}%` }}
            />
          </div>
        )}
        <div className="flex items-center gap-3 min-w-0">
          <Logo compact />
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-100 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800 text-[11px] font-mono text-zinc-600 dark:text-zinc-400">
            <span>
              {image.width} × {image.height}
            </span>
            <span>·</span>
            <span className="text-emerald-600 dark:text-emerald-400 font-medium">
              {image.latencyMs}ms
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 md:gap-2">
          <div className="hidden md:flex items-center gap-1 mr-1">
            <button
              type="button"
              title="Undo (Ctrl+Z)"
              onClick={handleUndo}
              disabled={historyState.index <= 0}
              className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-35 transition-colors"
            >
              <Undo2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              title="Redo (Ctrl+Y)"
              onClick={handleRedo}
              disabled={historyState.index >= historyState.length - 1}
              className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-35 transition-colors"
            >
              <Redo2 className="w-4 h-4" />
            </button>
          </div>

          <button
            onClick={onToggleDark}
            aria-label="Toggle theme"
            className="p-2 rounded-lg border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          {/* Subject Mode Switcher: Portrait (Hair) vs Product (Sharp) */}
          <div className="hidden lg:inline-flex items-center p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
            <button
              type="button"
              disabled={processing.isProcessing}
              onClick={() => onChangeSubjectMode('portrait')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
                subjectMode === 'portrait'
                  ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-white shadow-xs'
                  : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              <User className="w-3.5 h-3.5" />
              <span>Portrait</span>
            </button>
            <button
              type="button"
              disabled={processing.isProcessing}
              onClick={() => onChangeSubjectMode('product')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
                subjectMode === 'product'
                  ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-white shadow-xs'
                  : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              <Package className="w-3.5 h-3.5" />
              <span>Product</span>
            </button>
          </div>

          {onReprocessUltra && !image.backendLabel?.includes('1024px') && (
            <button
              onClick={onReprocessUltra}
              disabled={processing.isProcessing}
              title="Re-run with 1024px Ultra HD model for complex hair/backgrounds"
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blue-200 dark:border-blue-800/70 bg-blue-50/70 dark:bg-blue-950/40 text-xs font-semibold text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50 disabled:opacity-50 transition-colors"
            >
              <Zap className="w-3.5 h-3.5" />
              <span>Ultra HD</span>
            </button>
          )}

          <button
            onClick={onReset}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs sm:text-sm font-medium text-zinc-800 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
          >
            <FilePlus2 className="w-3.5 h-3.5" />
            <span>New</span>
          </button>

          {/* Primary Export Dropdown (Desktop) */}
          <div className="relative hidden md:block">
            <button
              onClick={() => setShowExportMenu((v) => !v)}
              className="inline-flex items-center gap-2 px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold shadow-sm active:scale-[0.98] transition-all"
            >
              <Download className="w-4 h-4" />
              <span>Export</span>
              <ChevronDown className="w-3.5 h-3.5 opacity-80" />
            </button>

            {showExportMenu && (
              <div className="absolute right-0 mt-1.5 w-48 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-lg py-1.5 z-50">
                <button
                  onClick={() => handleExport('png')}
                  className="w-full px-3.5 py-2 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-between"
                >
                  <span className="font-semibold text-zinc-900 dark:text-zinc-100">PNG (Transparent)</span>
                  <span className="font-mono text-[10px] text-zinc-400">32-bit</span>
                </button>
                <button
                  onClick={() => handleExport('webp')}
                  className="w-full px-3.5 py-2 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-between"
                >
                  <span className="font-semibold text-zinc-900 dark:text-zinc-100">WebP (Lossless)</span>
                  <span className="font-mono text-[10px] text-zinc-400">Small</span>
                </button>
                <button
                  onClick={() => handleExport('jpeg')}
                  className="w-full px-3.5 py-2 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-between"
                >
                  <span className="font-semibold text-zinc-900 dark:text-zinc-100">JPEG (Solid BG)</span>
                  <span className="font-mono text-[10px] text-zinc-400">95%</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Studio Body */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Desktop Left Icon Rail */}
        <aside className="hidden md:flex w-[68px] shrink-0 flex-col items-center py-3 gap-1.5 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
          {(
            [
              { id: 'canvas', label: 'Canvas', icon: Crop },
              { id: 'background', label: 'Background', icon: Droplet },
              { id: 'refine', label: 'Refine', icon: Wand2 },
              { id: 'settings', label: 'Settings', icon: Settings },
            ] as const
          ).map((item) => {
            const Icon = item.icon;
            const active = leftTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setLeftTab(item.id);
                  if (item.id === 'refine') {
                    setInteractionMode('brush');
                    setSplitPos(0);
                  } else if (item.id === 'canvas') {
                    setInteractionMode('split');
                    setSplitPos(50);
                  }
                }}
                className={`w-14 py-2 rounded-xl flex flex-col items-center gap-1 text-[11px] font-medium transition-colors ${
                  active
                    ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400'
                    : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-900'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </aside>

        {/* Center 60fps Interactive Canvas (Supports 25%-800% Photoshop Zoom & Pan) */}
        <main
          ref={mainRef}
          className="flex-1 relative flex items-center justify-center p-3 sm:p-6 overflow-hidden"
        >
          <div
            ref={stageRef}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              if (e.button === 1 || interactionMode === 'pan') {
                e.preventDefault();
                setIsPanning(true);
                panStartRef.current = {
                  x: e.clientX,
                  y: e.clientY,
                  panX: pan.x,
                  panY: pan.y,
                };
              } else if (interactionMode === 'brush' && !processing.isProcessing) {
                setIsPainting(true);
                lastBrushPtRef.current = null;
                paintBrushAt(e.clientX, e.clientY);
              } else {
                setIsDraggingSplit(true);
                updateSplitFromClientX(e.clientX);
              }
            }}
            onPointerMove={(e) => {
              if (isPanning && panStartRef.current) {
                setPan({
                  x: panStartRef.current.panX + (e.clientX - panStartRef.current.x),
                  y: panStartRef.current.panY + (e.clientY - panStartRef.current.y),
                });
                return;
              }
              if (interactionMode === 'brush') {
                const rect = stageRef.current?.getBoundingClientRect();
                if (rect) {
                  setCursorPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                }
                if (isPainting) paintBrushAt(e.clientX, e.clientY);
              }
            }}
            onPointerUp={() => {
              if (isPanning) {
                setIsPanning(false);
                panStartRef.current = null;
              }
              if (isPainting) {
                setIsPainting(false);
                lastBrushPtRef.current = null;
                commitBrushStroke();
              }
            }}
            onPointerLeave={() => {
              setCursorPos(null);
              if (isPanning) {
                setIsPanning(false);
                panStartRef.current = null;
              }
              if (isPainting) {
                setIsPainting(false);
                lastBrushPtRef.current = null;
                commitBrushStroke();
              }
            }}
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom / 100})`,
            }}
            className={`relative w-full max-w-3xl aspect-[4/3] rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-800 shadow-sm bg-checkerboard touch-none ${
              interactionMode === 'brush'
                ? 'cursor-none'
                : interactionMode === 'pan'
                ? isPanning
                  ? 'cursor-grabbing'
                  : 'cursor-grab'
                : 'cursor-ew-resize'
            }`}
          >
            {/* Custom / Solid / Gradient Background Layer (After Side) */}
            {bgSettings.mode !== 'transparent' && (
              <div className="absolute inset-0" style={renderBackgroundStyle()} />
            )}

            {/* Live Editable Cutout Foreground Canvas */}
            <canvas
              ref={cutoutCanvasRef}
              className="absolute inset-0 w-full h-full object-contain pointer-events-none"
            />

            {/* Brush Cursor Preview */}
            {interactionMode === 'brush' && cursorPos && (
              <div
                className={`absolute rounded-full border-2 pointer-events-none z-30 -translate-x-1/2 -translate-y-1/2 ${
                  refineSettings.tool === 'keep'
                    ? 'border-blue-500 bg-blue-500/15'
                    : 'border-red-500 bg-red-500/15'
                }`}
                style={{
                  left: cursorPos.x,
                  top: cursorPos.y,
                  width: refineSettings.brushSize,
                  height: refineSettings.brushSize,
                }}
              />
            )}

            {/* Original Layer (Clipped to Left of Split Slider, or 100% when holding Space) */}
            <div
              className="absolute inset-0 overflow-hidden pointer-events-none"
              style={{
                clipPath: holdOriginal
                  ? 'inset(0 0% 0 0)'
                  : `inset(0 ${100 - splitPos}% 0 0)`,
              }}
            >
              <img
                src={image.originalUrl}
                alt="Original"
                draggable={false}
                className="w-full h-full object-contain bg-zinc-200 dark:bg-zinc-900"
              />
            </div>

            {/* Before / After Corner Badges */}
            <span className="absolute top-3 left-3 px-2.5 py-1 rounded-md text-xs font-medium bg-zinc-950/75 text-white backdrop-blur-sm pointer-events-none">
              Before
            </span>
            <span className="absolute top-3 right-3 px-2.5 py-1 rounded-md text-xs font-medium bg-zinc-950/75 text-white backdrop-blur-sm pointer-events-none">
              After
            </span>

            {/* Live Smooth Progress Card */}
            {processing.isProcessing && (
              <div className="absolute inset-0 z-30 bg-zinc-950/30 backdrop-blur-[3px] flex items-center justify-center pointer-events-none px-4">
                <div className="w-full max-w-[260px] rounded-2xl bg-white/95 dark:bg-zinc-900/95 border border-zinc-200 dark:border-zinc-700 shadow-xl p-4 space-y-2.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                    <span>{processing.message || 'Removing background…'}</span>
                    <span className="font-mono text-blue-600 dark:text-blue-400">
                      {Math.max(8, processing.progress)}%
                    </span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-blue-600 transition-all duration-200 ease-out"
                      style={{ width: `${Math.max(8, processing.progress)}%` }}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Non-intrusive Error Banner */}
            {processing.error && (
              <div className="absolute top-12 left-1/2 -translate-x-1/2 z-30 px-4 py-2 rounded-xl bg-red-600 text-white text-xs font-medium shadow-lg max-w-sm text-center">
                {processing.error}
              </div>
            )}

            {/* Vertical Split Divider + Circular Handle */}
            {!holdOriginal && (
              <div
                className="absolute inset-y-0 w-[2px] bg-white shadow-[0_0_8px_rgba(0,0,0,0.4)] pointer-events-none"
                style={{ left: `${splitPos}%` }}
              >
                <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 md:w-9 md:h-9 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-md flex items-center justify-center text-zinc-700 dark:text-zinc-200">
                  <MoveHorizontal className="w-4 h-4" />
                </div>
              </div>
            )}
          </div>

          {/* Floating Photoshop-Grade Zoom (25%-800%) + Pan Controls */}
          <div className="hidden md:flex absolute bottom-4 left-4 items-center gap-1 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-sm border border-zinc-200 dark:border-zinc-800 rounded-lg px-2 py-1 shadow-sm z-30">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(25, z - 25))}
              title="Zoom Out"
              className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <select
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              aria-label="Zoom level"
              className="bg-transparent text-xs font-mono font-medium text-zinc-800 dark:text-zinc-200 outline-none cursor-pointer px-0.5"
            >
              <option value={25}>25%</option>
              <option value={50}>50%</option>
              <option value={75}>75%</option>
              <option value={100}>100%</option>
              <option value={150}>150%</option>
              <option value={200}>200%</option>
              <option value={400}>400%</option>
              <option value={600}>600%</option>
              <option value={800}>800%</option>
            </select>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(800, z + 50))}
              title="Zoom In"
              className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <span className="h-3.5 w-px bg-zinc-200 dark:bg-zinc-700 mx-0.5" />
            <button
              type="button"
              onClick={() =>
                setInteractionMode((m) => (m === 'pan' ? 'split' : 'pan'))
              }
              title="Hand / Pan Tool (Drag zoomed photo)"
              className={`inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded ${
                interactionMode === 'pan'
                  ? 'bg-blue-600 text-white'
                  : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              <Hand className="w-3 h-3" />
              <span>Pan</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setZoom(100);
                setPan({ x: 0, y: 0 });
              }}
              className="inline-flex items-center gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:text-blue-600 px-1.5 py-0.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <Maximize2 className="w-3 h-3" />
              <span>Fit</span>
            </button>
          </div>

          <button
            onPointerDown={() => setHoldOriginal(true)}
            onPointerUp={() => setHoldOriginal(false)}
            onPointerLeave={() => setHoldOriginal(false)}
            className="hidden md:inline-flex absolute bottom-4 right-4 items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900/85 hover:bg-zinc-900 text-white text-xs font-medium backdrop-blur-sm shadow-sm transition-colors"
          >
            Hold Space: Original
          </button>
        </main>

        {/* Desktop Right Inspector Panel (280px fixed) */}
        <aside className="hidden md:flex w-[280px] shrink-0 flex-col border-l border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 overflow-y-auto">
          {/* Background Section */}
          <div className="border-b border-zinc-200 dark:border-zinc-800 p-4">
            <button
              onClick={() => setBgOpen((v) => !v)}
              className="w-full flex items-center justify-between text-sm font-semibold text-zinc-900 dark:text-zinc-100"
            >
              <span>Background</span>
              {bgOpen ? <ChevronUp className="w-4 h-4 text-zinc-400" /> : <ChevronDown className="w-4 h-4 text-zinc-400" />}
            </button>

            {bgOpen && (
              <div className="mt-3 space-y-4">
                <div className="grid grid-cols-4 gap-1.5">
                  {(
                    [
                      { id: 'transparent', label: 'Trans.' },
                      { id: 'solid', label: 'Solid' },
                      { id: 'gradient', label: 'Gradient' },
                      { id: 'photo', label: 'Photo' },
                    ] as { id: BackgroundMode; label: string }[]
                  ).map((m) => {
                    const active = bgSettings.mode === m.id;
                    return (
                      <button
                        key={m.id}
                        onClick={() => {
                          if (m.id === 'photo' && !bgSettings.customPhotoUrl) {
                            bgPhotoInputRef.current?.click();
                          } else {
                            setBgSettings((s) => ({ ...s, mode: m.id }));
                          }
                        }}
                        className={`flex flex-col items-center gap-1 p-1.5 rounded-xl border text-[11px] font-medium transition-all ${
                          active
                            ? 'border-blue-600 bg-blue-50/50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400'
                            : 'border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300'
                        }`}
                      >
                        <span
                          className={`w-8 h-8 rounded-lg border border-zinc-200 dark:border-zinc-700 flex items-center justify-center ${
                            m.id === 'transparent'
                              ? 'bg-checkerboard'
                              : m.id === 'solid'
                              ? 'bg-white dark:bg-zinc-800'
                              : m.id === 'gradient'
                              ? 'bg-gradient-to-br from-blue-600 to-cyan-400'
                              : 'bg-zinc-100 dark:bg-zinc-800'
                          }`}
                        >
                          {m.id === 'photo' && <ImageIcon className="w-3.5 h-3.5" />}
                        </span>
                        <span>{m.label}</span>
                      </button>
                    );
                  })}
                </div>

                <input
                  ref={bgPhotoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const url = URL.createObjectURL(f);
                    setBgSettings((s) => ({ ...s, mode: 'photo', customPhotoUrl: url }));
                  }}
                />

                {/* Swatch row for Solid or Gradient */}
                {bgSettings.mode === 'solid' && (
                  <div className="flex flex-wrap gap-2">
                    {SOLID_SWATCHES.map((c) => (
                      <button
                        key={c}
                        onClick={() => setBgSettings((s) => ({ ...s, solidColor: c }))}
                        style={{ backgroundColor: c }}
                        className={`w-6 h-6 rounded-full border ${
                          bgSettings.solidColor === c
                            ? 'ring-2 ring-blue-600 ring-offset-2 dark:ring-offset-zinc-950 border-transparent'
                            : 'border-zinc-300 dark:border-zinc-700'
                        }`}
                      />
                    ))}
                  </div>
                )}

                {bgSettings.mode === 'gradient' && (
                  <div className="flex flex-wrap gap-2">
                    {GRADIENT_SWATCHES.map((g) => (
                      <button
                        key={g}
                        onClick={() => setBgSettings((s) => ({ ...s, gradientCss: g }))}
                        style={{ background: g }}
                        className={`w-7 h-7 rounded-lg border ${
                          bgSettings.gradientCss === g
                            ? 'ring-2 ring-blue-600 ring-offset-2 dark:ring-offset-zinc-950 border-transparent'
                            : 'border-zinc-300 dark:border-zinc-700'
                        }`}
                      />
                    ))}
                  </div>
                )}

                {/* Blur Slider */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-600 dark:text-zinc-400 font-medium">Blur</span>
                    <span className="font-mono text-zinc-700 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-900 px-1.5 py-0.5 rounded">
                      {bgSettings.blurPx} px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={24}
                    value={bgSettings.blurPx}
                    onChange={(e) =>
                      setBgSettings((s) => ({ ...s, blurPx: Number(e.target.value) }))
                    }
                    className="w-full studio-slider"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Refine Edges Section */}
          <div className="p-4">
            <button
              onClick={() => setRefineOpen((v) => !v)}
              className="w-full flex items-center justify-between text-sm font-semibold text-zinc-900 dark:text-zinc-100"
            >
              <span>Refine Edges</span>
              {refineOpen ? <ChevronUp className="w-4 h-4 text-zinc-400" /> : <ChevronDown className="w-4 h-4 text-zinc-400" />}
            </button>

            {refineOpen && (
              <div className="mt-3 space-y-4">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => {
                      setRefineSettings((s) => ({ ...s, tool: 'keep' }));
                      setInteractionMode('brush');
                      setLeftTab('refine');
                      setSplitPos(0);
                    }}
                    className={`py-2 px-3 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 border transition-colors ${
                      interactionMode === 'brush' && refineSettings.tool === 'keep'
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-800'
                    }`}
                  >
                    <Paintbrush className="w-3.5 h-3.5" />
                    Keep
                  </button>
                  <button
                    onClick={() => {
                      setRefineSettings((s) => ({ ...s, tool: 'erase' }));
                      setInteractionMode('brush');
                      setLeftTab('refine');
                      setSplitPos(0);
                    }}
                    className={`py-2 px-3 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-1.5 border transition-colors ${
                      interactionMode === 'brush' && refineSettings.tool === 'erase'
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-800'
                    }`}
                  >
                    <Eraser className="w-3.5 h-3.5" />
                    Erase
                  </button>
                </div>
                {interactionMode === 'brush' && (
                  <button
                    onClick={() => {
                      setInteractionMode('split');
                      setLeftTab('canvas');
                      setSplitPos(50);
                    }}
                    className="w-full py-1.5 rounded-lg text-[11px] font-medium text-blue-600 dark:text-blue-400 bg-blue-50/70 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-950/50 transition-colors"
                  >
                    Back to Split Slider
                  </button>
                )}

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-600 dark:text-zinc-400 font-medium">Brush Size</span>
                    <span className="font-mono text-zinc-700 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-900 px-1.5 py-0.5 rounded">
                      {refineSettings.brushSize} px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={4}
                    max={100}
                    value={refineSettings.brushSize}
                    onChange={(e) =>
                      setRefineSettings((s) => ({ ...s, brushSize: Number(e.target.value) }))
                    }
                    className="w-full studio-slider"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-600 dark:text-zinc-400 font-medium">Feather</span>
                    <span className="font-mono text-zinc-700 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-900 px-1.5 py-0.5 rounded">
                      {refineSettings.feather} px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={20}
                    value={refineSettings.feather}
                    onChange={(e) =>
                      setRefineSettings((s) => ({ ...s, feather: Number(e.target.value) }))
                    }
                    className="w-full studio-slider"
                  />
                </div>

                {/* Live 60fps Defringe Slider (White/Black Halo Tightener) */}
                <div className="space-y-1.5 pt-1 border-t border-zinc-100 dark:border-zinc-800/80">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-600 dark:text-zinc-400 font-medium">
                      Defringe Hair
                    </span>
                    <span className="font-mono text-zinc-700 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-900 px-1.5 py-0.5 rounded">
                      {defringe}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={defringe}
                    onChange={(e) => handleDefringeChange(Number(e.target.value))}
                    className="w-full studio-slider"
                  />
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Desktop Bottom Status Bar (36px) */}
      <footer className="hidden md:flex h-9 shrink-0 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-4 items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              processing.isProcessing ? 'bg-blue-600 animate-pulse' : 'bg-emerald-500'
            }`}
          />
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {processing.isProcessing ? processing.message || 'Processing…' : 'Ready'}
          </span>
        </div>
        <div className="flex items-center gap-1.5 font-medium">
          <Zap className="w-3.5 h-3.5 text-amber-500" />
          <span>On-Device Studio · Private &amp; Fast</span>
        </div>
        <div className="font-mono">
          {image.width} × {image.height}
        </div>
      </footer>

      {/* Mobile Thumb-Zone Bottom Dock (< md) */}
      <div className="md:hidden shrink-0 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 pt-2.5 pb-3 space-y-2.5 z-30">
        {/* Floating Pill Switcher */}
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => {
              setMobileSheet('background');
              setInteractionMode('split');
              setSplitPos(50);
            }}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold inline-flex items-center gap-1.5 border ${
              mobileSheet === 'background'
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-zinc-100 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-800'
            }`}
          >
            <Droplet className="w-3.5 h-3.5" />
            Background
          </button>
          <button
            onClick={() => {
              setMobileSheet('brush');
              setInteractionMode('brush');
              setSplitPos(0);
            }}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold inline-flex items-center gap-1.5 border ${
              mobileSheet === 'brush'
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-zinc-100 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-800'
            }`}
          >
            <Paintbrush className="w-3.5 h-3.5" />
            Brush
          </button>
          <button
            onClick={() => setZoom(100)}
            className="px-3 py-1.5 rounded-full text-xs font-medium bg-zinc-100 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-800 inline-flex items-center gap-1"
          >
            <Maximize2 className="w-3 h-3" />
            Fit
          </button>
        </div>

        {/* Horizontal Swatch Strip */}
        {mobileSheet === 'background' ? (
          <div className="flex items-center justify-center gap-2.5 overflow-x-auto py-0.5">
            <button
              onClick={() => setBgSettings((s) => ({ ...s, mode: 'transparent' }))}
              aria-label="Transparent background"
              className={`w-10 h-10 shrink-0 rounded-xl border bg-checkerboard ${
                bgSettings.mode === 'transparent' ? 'ring-2 ring-blue-600' : 'border-zinc-300 dark:border-zinc-700'
              }`}
            />
            {SOLID_SWATCHES.slice(0, 3).map((c) => (
              <button
                key={c}
                onClick={() => setBgSettings((s) => ({ ...s, mode: 'solid', solidColor: c }))}
                style={{ backgroundColor: c }}
                className={`w-10 h-10 shrink-0 rounded-xl border ${
                  bgSettings.mode === 'solid' && bgSettings.solidColor === c
                    ? 'ring-2 ring-blue-600'
                    : 'border-zinc-300 dark:border-zinc-700'
                }`}
              />
            ))}
            <button
              onClick={() => setBgSettings((s) => ({ ...s, mode: 'gradient' }))}
              aria-label="Gradient background"
              style={{ background: GRADIENT_SWATCHES[0] }}
              className={`w-10 h-10 shrink-0 rounded-xl border ${
                bgSettings.mode === 'gradient' ? 'ring-2 ring-blue-600' : 'border-zinc-300 dark:border-zinc-700'
              }`}
            />
          </div>
        ) : (
          <div className="flex items-center justify-center gap-3 py-1">
            <button
              onClick={() => setRefineSettings((s) => ({ ...s, tool: 'keep' }))}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold ${
                refineSettings.tool === 'keep'
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-100 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300'
              }`}
            >
              Keep
            </button>
            <button
              onClick={() => setRefineSettings((s) => ({ ...s, tool: 'erase' }))}
              className={`px-4 py-1.5 rounded-lg text-xs font-semibold ${
                refineSettings.tool === 'erase'
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-100 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300'
              }`}
            >
              Erase
            </button>
          </div>
        )}

        {/* Full-Width Save Image CTA */}
        <button
          onClick={() => handleExport('png')}
          className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm inline-flex items-center justify-center gap-2 active:scale-[0.99] transition-all"
        >
          <span>Save Image</span>
          <Download className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
