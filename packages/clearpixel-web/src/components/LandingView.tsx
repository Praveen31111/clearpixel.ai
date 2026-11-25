'use client';

import React, { useRef, useState, useEffect } from 'react';
import { UploadCloud, ShieldCheck, Sun, Moon, Sparkles, Scissors } from 'lucide-react';
import { Logo } from './Logo';
import { SAMPLE_PRESETS, SampleItem } from '@/lib/sample-generator';
import { getModelCacheStatus } from '@/lib/model-cache';
import type { AppTool } from '@/types/studio';

interface LandingViewProps {
  darkMode: boolean;
  appTool: AppTool;
  onChangeTool: (tool: AppTool) => void;
  onToggleDark: () => void;
  onFileSelected: (file: File) => void;
  onSampleSelected: (preset: SampleItem) => void;
}

export function LandingView({
  darkMode,
  appTool,
  onChangeTool,
  onToggleDark,
  onFileSelected,
  onSampleSelected,
}: LandingViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isCached, setIsCached] = useState(false);

  useEffect(() => {
    getModelCacheStatus().then((s) => setIsCached(s.cached));
  }, []);

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) {
            onFileSelected(file);
            break;
          }
        }
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [onFileSelected]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      onFileSelected(file);
    }
  };

  return (
    <div className="min-h-dvh flex flex-col bg-gradient-to-b from-[#F8FAFF] via-[#F3F7FF] to-[#FFFFFF] dark:from-[#09090B] dark:via-[#09090B] dark:to-[#09090B]">
      {/* Exact Reference Header */}
      <header className="w-full bg-white/75 dark:bg-zinc-950/80 backdrop-blur-md border-b border-slate-200/70 dark:border-zinc-800/80 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-8 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3.5">
            <Logo />
            <span className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-[#ECFDF5] text-[#047857] border border-[#A7F3D0] dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800/60">
              <ShieldCheck className="w-3.5 h-3.5" />
              {isCached ? 'On-Device · Instant Ready' : 'On-Device · Free'}
            </span>
          </div>

          <div className="flex items-center gap-3 sm:gap-4">
            {/* Tool Switcher: Remove BG | AI Upscale */}
            <div className="inline-flex items-center p-0.5 rounded-full bg-slate-100 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => onChangeTool('remove-bg')}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                  appTool === 'remove-bg'
                    ? 'bg-white dark:bg-zinc-800 text-slate-950 dark:text-white shadow-xs'
                    : 'text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200'
                }`}
              >
                <Scissors className="w-3.5 h-3.5" />
                <span>Remove BG</span>
              </button>
              <button
                type="button"
                onClick={() => onChangeTool('upscale')}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                  appTool === 'upscale'
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'text-slate-500 hover:text-slate-800 dark:hover:text-zinc-200'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>AI Upscale 4×</span>
              </button>
            </div>

            {/* Segmented Sun / Moon Pill */}
            <button
              onClick={onToggleDark}
              aria-label="Toggle color theme"
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xs"
            >
              <span
                className={`p-1 rounded-full transition-colors ${
                  !darkMode
                    ? 'bg-amber-50 text-amber-500'
                    : 'text-zinc-500'
                }`}
              >
                <Sun className="w-3.5 h-3.5" />
              </span>
              <span
                className={`p-1 rounded-full transition-colors ${
                  darkMode
                    ? 'bg-zinc-800 text-blue-400'
                    : 'text-slate-400'
                }`}
              >
                <Moon className="w-3.5 h-3.5" />
              </span>
            </button>

            <span className="hidden md:block h-5 w-px bg-slate-200 dark:bg-zinc-800" />

            <div className="hidden md:flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-zinc-400">
              <ShieldCheck className="w-4 h-4 text-slate-700 dark:text-zinc-300" />
              <span className="leading-tight">
                Images never
                <br />
                leave your device
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Main 3-Part Hero Matching Reference Layout */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-8 py-8 lg:py-12 flex items-center">
        <div className="w-full grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-6 items-center">
          {/* Left Column (5 cols): Headline + Dashed DropZone */}
          <div className="lg:col-span-5 space-y-6">
            <div className="space-y-3.5">
              <h1 className="text-4xl sm:text-5xl xl:text-[56px] font-extrabold tracking-[-0.03em] leading-[1.06] text-[#0F172A] dark:text-white">
                {appTool === 'upscale' ? 'Studio upscaling.' : 'Studio cutouts.'}
                <br />
                <span className="relative inline-block text-[#1D4ED8] dark:text-blue-500">
                  Zero uploads.
                  <svg
                    className="absolute -bottom-2 left-0 w-full h-3 text-[#2563EB]"
                    viewBox="0 0 280 14"
                    fill="none"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M3 10C75 3 190 2 277 9"
                      stroke="currentColor"
                      strokeWidth="3.2"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
              </h1>
              <p className="text-base sm:text-[17px] text-slate-600 dark:text-zinc-400 max-w-md leading-relaxed pt-1">
                {appTool === 'upscale'
                  ? '2× & 4× super-resolution in your browser. Crisp details, private, free.'
                  : 'Full-resolution background removal in your browser. Private, instant, free.'}
              </p>
            </div>

            {/* Dashed DropZone */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
              }}
              className={`group cursor-pointer rounded-2xl border-2 border-dashed p-6 sm:p-8 text-center transition-all duration-150 ${
                isDragging
                  ? 'border-blue-600 bg-blue-50/80 dark:bg-blue-950/30 scale-[1.01]'
                  : 'border-slate-300/90 dark:border-zinc-700 bg-white/85 dark:bg-zinc-900/70 hover:border-slate-400 dark:hover:border-zinc-600 shadow-xs'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/avif"
                className="hidden"
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) onFileSelected(file);
                }}
              />

              <div className="flex flex-col items-center gap-2.5">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                  className="inline-flex items-center gap-2.5 px-7 py-3.5 rounded-full bg-[#0F172A] dark:bg-white text-white dark:text-zinc-950 font-semibold text-sm sm:text-[15px] shadow-sm group-hover:bg-slate-800 dark:group-hover:bg-zinc-200 active:scale-[0.98] transition-all"
                >
                  <UploadCloud className="w-5 h-5" />
                  + Upload Image
                </button>
                <p className="text-xs sm:text-[13px] text-slate-500 dark:text-zinc-400">
                  or press <strong className="font-semibold text-slate-700 dark:text-zinc-200">Ctrl + V</strong> to paste
                </p>
              </div>
            </div>
          </div>

          {/* Center Column (3.5 -> 4 cols): Hero Cutout Portrait + "Perfect Cutout!" */}
          <div className="lg:col-span-4 relative flex items-center justify-center">
            <div className="relative w-full max-w-[340px] aspect-[4/4.3] rounded-3xl overflow-hidden border border-slate-200/80 dark:border-zinc-800 shadow-md bg-white dark:bg-zinc-900">
              {/* Right-half checkerboard reveal */}
              <div className="absolute inset-y-0 right-0 w-1/2 bg-checkerboard" />
              <img
                src="/samples/hero-portrait.jpg"
                alt="ClearPixel Studio Cutout Example"
                className="relative z-10 w-full h-full object-cover object-top mix-blend-multiply dark:mix-blend-normal"
              />
              {/* Handwritten "Perfect Cutout!" + Curved Blue Arrow */}
              <div className="absolute top-5 right-4 z-20 flex flex-col items-center pointer-events-none">
                <span className="font-hand text-xl sm:text-2xl font-bold text-[#0F172A] dark:text-white leading-none -rotate-6">
                  Perfect
                  <br />
                  Cutout!
                </span>
                <svg
                  width="36"
                  height="38"
                  viewBox="0 0 36 38"
                  fill="none"
                  className="text-[#2563EB] mt-1 -ml-3"
                >
                  <path
                    d="M26 2C24 14 17 24 5 29M5 29L13 22M5 29L14 33"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            </div>
          </div>

          {/* Right Column (3 cols): "Try these samples:" 4-Photo Card */}
          <div className="lg:col-span-3">
            <div className="rounded-2xl border border-slate-200/90 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 shadow-sm">
              <p className="text-sm font-bold text-[#0F172A] dark:text-zinc-100 mb-3">
                Try these samples:
              </p>
              <div className="grid grid-cols-4 gap-2">
                {SAMPLE_PRESETS.map((sample) => (
                  <button
                    key={sample.id}
                    type="button"
                    onClick={() => onSampleSelected(sample)}
                    title={`Try ${sample.label}`}
                    className="group relative aspect-[3/4.2] rounded-xl overflow-hidden border border-slate-200/80 dark:border-zinc-700 hover:border-blue-600 dark:hover:border-blue-500 hover:ring-2 hover:ring-blue-600/20 transition-all active:scale-[0.96]"
                  >
                    <img
                      src={sample.imageUrl}
                      alt={sample.label}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
