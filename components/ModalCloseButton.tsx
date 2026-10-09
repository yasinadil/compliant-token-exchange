type ModalCloseButtonProps = {
  /** Fired when the user dismisses the modal. */
  onClick: () => void;
  /**
   * Accessible name for the icon-only button (e.g. "Close" or a more
   * descriptive "Close tutorial and return to Sell"). Required because the X
   * has no visible text.
   */
  label: string;
  /**
   * Disable while a request is in flight so the modal can't be dismissed
   * mid-action. Defaults to false.
   */
  disabled?: boolean;
  /**
   * Extra positioning classes. Use `-mr-1` to nudge it in an in-flow header
   * row, or `absolute right-3 top-3` for a corner-anchored placement. The
   * visual style (size, hover, focus ring) is standardized here.
   */
  className?: string;
  /**
   * Button footprint. "md" (default) is the 36px control used by most
   * dialogs; "lg" is a roomier 44px target with a larger X, used by the
   * Buy / Sell / Convert review modals where the close sits alone in a
   * tall header.
   */
  size?: "md" | "lg";
};

/**
 * Shared modal close button — a round, ghost-style X used across the app's
 * dialogs (tutorial, review modals, …) so every modal closes the same way.
 * Extracted from the Sell tutorial modal's close button.
 */
export function ModalCloseButton({
  onClick,
  label,
  disabled = false,
  className = "",
  size = "md",
}: ModalCloseButtonProps) {
  const boxClass = size === "lg" ? "h-11 w-11" : "h-9 w-9";
  const iconSize = size === "lg" ? 20 : 16;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`grid ${boxClass} shrink-0 place-items-center rounded-full text-[#6B7280] transition-colors hover:bg-[#F3F4F6] hover:text-[#111827] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0EA5E9] disabled:opacity-50 ${className}`}
    >
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>
  );
}
