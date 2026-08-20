/**
 * The app name, rendered as text.
 *
 * It must read exactly "TurtleType" — the same string as the app name on the
 * Google OAuth consent screen. A previous version styled it as lowercase
 * `turtletype`, and Google's verification review rejected the homepage for it:
 * the reviewer compares the name on the consent screen against the name a
 * visitor can see, and "turtletype" is not "TurtleType".
 *
 * The colour split across the two words is decoration and does not change the
 * text content. Do not restyle this to lowercase, and do not replace it with
 * an image — a name only present inside a logo cannot be read as matching.
 */
export default function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-mono tracking-tight ${className}`}>
      Turtle<span className="text-accent-500">Type</span>
    </span>
  );
}
