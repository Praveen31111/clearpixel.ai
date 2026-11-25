'use client';

import React from 'react';

interface LogoProps {
  compact?: boolean;
}

export function Logo({ compact = false }: LogoProps) {
  return (
    <div className="inline-flex items-center gap-2 select-none">
      <svg
        width={compact ? 24 : 28}
        height={compact ? 24 : 28}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="shrink-0"
      >
        <path
          d="M16 3C8.82 3 3 8.82 3 16C3 23.18 8.82 29 16 29C20.55 29 24.55 26.66 26.86 23.12L21.95 19.86C20.66 21.76 18.48 23 16 23C12.13 23 9 19.87 9 16C9 12.13 12.13 9 16 9C18.48 9 20.66 10.24 21.95 12.14L26.86 8.88C24.55 5.34 20.55 3 16 3Z"
          fill="#2563EB"
        />
        <rect x="22" y="13" width="4" height="4" rx="1" fill="#3B82F6" />
        <rect x="26" y="17" width="3" height="3" rx="0.75" fill="#93C5FD" />
      </svg>
      <span
        className={`font-bold tracking-tight text-zinc-950 dark:text-zinc-50 ${
          compact ? 'text-[16px]' : 'text-[19px]'
        }`}
      >
        ClearPixel<span className="text-blue-600 dark:text-blue-500">.ai</span>
      </span>
    </div>
  );
}
