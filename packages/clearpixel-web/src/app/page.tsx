'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { LandingView } from '@/components/LandingView';
import { StudioWorkspace } from '@/components/StudioWorkspace';
import { buildSampleStudioImage, SampleItem } from '@/lib/sample-generator';
import { preloadAiEngine, runBackgroundRemoval } from '@/lib/ai-client';
import { ProcessingState, StudioImage } from '@/types/studio';
import type { SubjectMode } from '@/lib/edge-refiner';

export default function HomePage() {
  const [darkMode, setDarkMode] = useState(false);
  const [subjectMode, setSubjectMode] = useState<SubjectMode>('portrait');
  const [activeImage, setActiveImage] = useState<StudioImage | null>(null);
  const [processing, setProcessing] = useState<ProcessingState>({
    isProcessing: false,
    progress: 0,
    message: '',
    error: null,
  });

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [darkMode]);

  // Silent background pre-fetch for millisecond WebGPU Portrait Matting
  useEffect(() => {
    const timer = setTimeout(() => {
      preloadAiEngine('fast', 'portrait').catch(() => {
        // Silent pre-fetch failure is harmless; will retry on upload
      });
    }, 400);
    return () => clearTimeout(timer);
  }, []);

  const runCutout = useCallback(
    async (id: string, url: string, quality: 'fast' | 'ultra', subject: SubjectMode) => {
      setProcessing({
        isProcessing: true,
        progress: 8,
        message:
          quality === 'ultra'
            ? 'Running 1024px Ultra HD…'
            : subject === 'portrait'
            ? 'Running Portrait Hair Engine…'
            : 'Running Product Sharp Engine…',
        error: null,
      });

      try {
        const result = await runBackgroundRemoval(url, quality, subject, (p) => {
          setProcessing({
            isProcessing: true,
            progress: p.progress,
            message: p.message,
            error: null,
          });
        });

        const cutoutUrl = URL.createObjectURL(result.cutoutBlob);
        setActiveImage((prev) =>
          prev && prev.id === id
            ? {
                ...prev,
                cutoutUrl,
                width: result.width,
                height: result.height,
                latencyMs: result.latencyMs,
                backendLabel: result.backendLabel,
              }
            : prev
        );
        setProcessing({
          isProcessing: false,
          progress: 100,
          message: 'Done',
          error: null,
        });
      } catch (err) {
        setProcessing({
          isProcessing: false,
          progress: 0,
          message: '',
          error:
            err instanceof Error
              ? err.message
              : 'Failed to run background removal in this browser.',
        });
      }
    },
    []
  );

  const handleFileSelected = useCallback(
    (file: File) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const id = `upload-${Date.now()}`;
        setActiveImage({
          id,
          name: file.name,
          originalUrl: url,
          cutoutUrl: url,
          width: img.naturalWidth,
          height: img.naturalHeight,
          latencyMs: 0,
          backendLabel: 'Detecting Engine…',
        });
        runCutout(id, url, 'fast', subjectMode);
      };
      img.src = url;
    },
    [runCutout, subjectMode]
  );

  const handleSampleSelected = useCallback(async (preset: SampleItem) => {
    const isProduct = preset.id === 'perfume' || preset.id === 'sneaker';
    setSubjectMode(isProduct ? 'product' : 'portrait');
    const sample = await buildSampleStudioImage(preset);
    setActiveImage({
      ...sample,
      backendLabel: 'WebGPU Accelerated',
    });
    setProcessing({
      isProcessing: false,
      progress: 100,
      message: '',
      error: null,
    });
  }, []);

  if (activeImage) {
    return (
      <StudioWorkspace
        image={activeImage}
        processing={processing}
        darkMode={darkMode}
        subjectMode={subjectMode}
        onChangeSubjectMode={(nextMode) => {
          setSubjectMode(nextMode);
          runCutout(activeImage.id, activeImage.originalUrl, 'fast', nextMode);
        }}
        onToggleDark={() => setDarkMode((d) => !d)}
        onReprocessUltra={() =>
          runCutout(activeImage.id, activeImage.originalUrl, 'ultra', subjectMode)
        }
        onReset={() => {
          setActiveImage(null);
          setProcessing({ isProcessing: false, progress: 0, message: '', error: null });
        }}
      />
    );
  }

  return (
    <LandingView
      darkMode={darkMode}
      onToggleDark={() => setDarkMode((d) => !d)}
      onFileSelected={handleFileSelected}
      onSampleSelected={handleSampleSelected}
    />
  );
}
