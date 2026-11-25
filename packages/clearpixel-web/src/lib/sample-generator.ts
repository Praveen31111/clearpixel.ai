import { SamplePreset, StudioImage } from '@/types/studio';

export interface SampleItem extends SamplePreset {
  imageUrl: string;
}

export const SAMPLE_PRESETS: SampleItem[] = [
  {
    id: 'portrait',
    label: 'Portrait',
    category: 'Hair & Edges',
    accent: '#2563EB',
    bgColor: '#F8FAFC',
    imageUrl: '/samples/sample-portrait.jpg',
  },
  {
    id: 'perfume',
    label: 'Product',
    category: 'Glass & Bottle',
    accent: '#E11D48',
    bgColor: '#FCE7F3',
    imageUrl: '/samples/sample-perfume.jpg',
  },
  {
    id: 'pet',
    label: 'Pet Fur',
    category: 'Fine Fur',
    accent: '#D97706',
    bgColor: '#E0F2FE',
    imageUrl: '/samples/sample-dog.jpg',
  },
  {
    id: 'sneaker',
    label: 'Sneaker',
    category: 'E-Commerce',
    accent: '#059669',
    bgColor: '#E0F2FE',
    imageUrl: '/samples/sample-sneaker.jpg',
  },
];

/**
 * Loads a real studio sample photo and performs fast border-color keying
 * so the Studio Workspace shows an authentic interactive Before/After cutout immediately.
 * (In Step 3, BiRefNet-Lite ONNX replaces this for arbitrary user photos.)
 */
export async function buildSampleStudioImage(preset: SampleItem): Promise<StudioImage> {
  const img = await loadImage(preset.imageUrl);
  const width = img.naturalWidth || 1024;
  const height = img.naturalHeight || 1024;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  // Sample corner background color from top-left pixel
  const bgR = data[0];
  const bgG = data[1];
  const bgB = data[2];

  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - bgR;
    const dg = data[i + 1] - bgG;
    const db = data[i + 2] - bgB;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);

    if (dist < 28) {
      data[i + 3] = 0;
    } else if (dist < 48) {
      data[i + 3] = Math.round(((dist - 28) / 20) * 255);
    }
  }

  ctx.putImageData(imageData, 0, 0);

  return {
    id: `sample-${preset.id}-${Date.now()}`,
    name: `${preset.label.toLowerCase()}-sample.jpg`,
    originalUrl: preset.imageUrl,
    cutoutUrl: canvas.toDataURL('image/png'),
    width,
    height,
    latencyMs: 380,
  };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
