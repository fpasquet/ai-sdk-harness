import { AUTHOR_NAME, AUTHOR_URL, GITHUB_URL } from '@/lib/constants';

export function Footer({ className }: { className?: string }) {
  return (
    <footer className={className}>
      <div
        className="
          mx-auto flex w-full max-w-6xl flex-wrap items-center justify-center gap-x-2 gap-y-1
          px-6 py-8 text-sm text-fd-muted-foreground
        "
      >
        <span>MIT licensed · built by</span>
        <a className="font-medium text-fd-foreground hover:underline" href={AUTHOR_URL}>
          {AUTHOR_NAME}
        </a>
        <span>·</span>
        <a className="hover:underline" href={GITHUB_URL}>
          GitHub
        </a>
      </div>
    </footer>
  );
}
