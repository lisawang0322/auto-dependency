import type { ReactNode } from "react";

/** The why behind a line, kept out of the way: an "i" that shows it on hover, focus or tap. */
export function Info({ children, label = "More about this" }: { children: ReactNode; label?: string }) {
  return (
    <span className="info">
      <button type="button" className="info-btn" aria-label={label}>i</button>
      <span role="tooltip" className="info-tip">{children}</span>
    </span>
  );
}
