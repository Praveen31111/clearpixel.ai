import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-[#F8FAFF] dark:bg-[#09090B] text-center px-4">
      <h1 className="text-3xl font-extrabold text-slate-900 dark:text-white">404</h1>
      <p className="mt-2 text-sm text-slate-500 dark:text-zinc-400">Page not found.</p>
      <Link
        href="/"
        className="mt-5 px-5 py-2.5 rounded-full bg-[#0F172A] dark:bg-white text-white dark:text-zinc-950 text-sm font-semibold"
      >
        Back to ClearPixel.ai
      </Link>
    </div>
  );
}
