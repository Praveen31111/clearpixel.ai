export type AppTool = 'remove-bg' | 'upscale';

export type UpscaleScale = 2 | 4;

export type BackgroundMode = 'transparent' | 'solid' | 'gradient' | 'photo';

export type BrushTool = 'keep' | 'erase';

export type ExportFormat = 'png' | 'webp' | 'jpeg';

export type LeftRailTab = 'canvas' | 'background' | 'refine' | 'settings';

export interface StudioLayer {
  id: string;
  name: string;
  visible: boolean;
  cutoutUrl: string;
  offsetX: number;
  offsetY: number;
}

export interface StudioImage {
  id: string;
  name: string;
  originalUrl: string;
  cutoutUrl: string;
  width: number;
  height: number;
  latencyMs: number;
  backendLabel?: string;
  layers?: StudioLayer[];
}

export interface ProcessingState {
  isProcessing: boolean;
  progress: number;
  message: string;
  error: string | null;
}

export interface BackgroundSettings {
  mode: BackgroundMode;
  solidColor: string;
  gradientCss: string;
  customPhotoUrl: string | null;
  blurPx: number;
}

export interface RefineSettings {
  tool: BrushTool;
  brushSize: number;
  feather: number;
}

export interface SamplePreset {
  id: string;
  label: string;
  category: string;
  accent: string;
  bgColor: string;
}
