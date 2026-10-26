import type { Editor, EditorPosition } from "obsidian";

const MARKDOWN_LINK_IN_LINE = /\[[^\]]*\]\(https?:\/\/[^\s)]+\)/gi;
const URL_IN_LINE = /https?:\/\/[^\s<>"'`]+/gi;

export interface EditorTextRange {
  start: EditorPosition;
  end: EditorPosition;
  text: string;
}

export function getSelectionOrUrl(editor: Editor): EditorTextRange {
  const start = editor.getCursor("from");
  const end = editor.getCursor("to");
  const selected = editor.getSelection();
  if (selected) return { start, end, text: selected };

  const line = editor.getLine(start.line);
  const link = findMatchAtCursor(line, MARKDOWN_LINK_IN_LINE, start.ch);
  if (link) {
    return {
      start: { line: start.line, ch: link.index },
      end: { line: start.line, ch: link.index + link[0].length },
      text: link[0],
    };
  }

  const url = findMatchAtCursor(line, URL_IN_LINE, start.ch);
  if (url) {
    return {
      start: { line: start.line, ch: url.index },
      end: { line: start.line, ch: url.index + url[0].length },
      text: url[0],
    };
  }

  return { start, end: start, text: "" };
}

export function getSelectedText(editor: Editor): string {
  return getSelectionOrUrl(editor).text;
}

export function getEditorPositionFromIndex(
  content: string,
  index: number,
): EditorPosition {
  const safeIndex = Math.max(0, Math.min(index, content.length));
  const before = content.slice(0, safeIndex);
  const line = before.split("\n").length - 1;
  const lastLineBreak = before.lastIndexOf("\n");
  return { line, ch: safeIndex - lastLineBreak - 1 };
}

export function getIndexFromEditorPosition(
  content: string,
  position: EditorPosition,
): number {
  const lines = content.split("\n");
  const line = Math.max(0, Math.min(position.line, lines.length - 1));
  let index = 0;
  for (let current = 0; current < line; current++)
    index += lines[current].length + 1;
  return index + Math.max(0, Math.min(position.ch, lines[line].length));
}

function findMatchAtCursor(
  line: string,
  pattern: RegExp,
  cursor: number,
): RegExpExecArray | null {
  const matcher = new RegExp(pattern.source, pattern.flags);
  while (true) {
    const match = matcher.exec(line);
    if (!match) return null;
    const start = match.index;
    const end = start + match[0].length;
    if (start <= cursor && cursor <= end) return match;
    if (match[0].length === 0) matcher.lastIndex++;
  }
}
