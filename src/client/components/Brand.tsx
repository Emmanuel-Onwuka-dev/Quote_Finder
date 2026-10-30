// Original brand artwork: a curly-quote logo mark and a flat magnifier
// icon. Token colors only, no gradients, no third-party images.

export function LogoMark({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`font-display font-bold leading-none text-accent ${className}`}
    >
      &ldquo;&rdquo;
    </span>
  );
}

export function Magnifier({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <line
        x1="13.5"
        y1="13.5"
        x2="20"
        y2="20"
        className="stroke-foreground"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <line
        x1="13.5"
        y1="13.5"
        x2="20"
        y2="20"
        className="stroke-accent"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <circle cx="10" cy="10" r="7.2" className="fill-accent" />
      <circle
        cx="10"
        cy="10"
        r="7.2"
        fill="none"
        className="stroke-foreground"
        strokeWidth="1.2"
      />
      <circle
        cx="10"
        cy="10"
        r="4.6"
        className="fill-card stroke-foreground"
        strokeWidth="1.2"
      />
    </svg>
  );
}
