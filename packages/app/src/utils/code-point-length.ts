/**
 * Length of `text` in code points — the unit the renderer counts characters in.
 *
 * `@my-react/react-terminal` parses a `<Text>`'s content into one styled character per code point
 * (`buildStyledLine` walks with `codePointAt`), and `terminalCursorPosition` indexes that array. So
 * an astral character (emoji) counts once, not twice: `String#length` would be off by one per emoji
 * before the caret, which puts the IME candidate window on the wrong cell in exactly the messages
 * people type emoji into.
 *
 * @example
 * codePointLength("🎉b"); // 2, not 3
 */
export function codePointLength(text: string): number {
  // `for…of` / `Array.from` iterate by code point, the unit the renderer's cursor indexes.
  return Array.from(text).length;
}
