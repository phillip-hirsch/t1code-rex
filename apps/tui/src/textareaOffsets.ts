import type { TextareaRenderable } from "@opentui/core";

/**
 * OpenTUI's cursor offsets count display columns: a wide character or emoji is 2, a
 * combining mark 0, a newline 1. JS strings count UTF-16 units. These convert through the
 * textarea's own buffer, so they match however OpenTUI measures a grapheme.
 */
type Textarea = Pick<TextareaRenderable, "cursorOffset" | "editBuffer" | "plainText">;

/** The cursor's position in `plainText`, in UTF-16 units. */
export function cursorStringOffset(textarea: Textarea): number {
  return textarea.editBuffer.getTextRange(0, textarea.cursorOffset).length;
}

/**
 * Replaces the `length` UTF-16 units before the cursor with `text`. Deletes whole graphemes,
 * as Backspace does, until that much text is gone.
 */
export function replaceBeforeCursor(
  textarea: Textarea &
    Pick<TextareaRenderable, "clearSelection" | "deleteCharBackward" | "insertText">,
  length: number,
  text: string,
): void {
  // With a selection, Backspace deletes the selection instead of one grapheme, so the
  // length check below would remove the wrong text.
  textarea.clearSelection();
  const target = textarea.plainText.length - length;
  while (textarea.plainText.length > target && textarea.deleteCharBackward()) {
    // Each pass removes one grapheme.
  }
  textarea.insertText(text);
}
