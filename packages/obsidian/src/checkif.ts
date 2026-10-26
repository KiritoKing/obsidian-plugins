import type { Editor } from "obsidian";
import { parseWebUrl } from "@chlrc/browser-profile-title-protocol";
import { getIndexFromEditorPosition } from "./editor-enhancements";

const IMAGE_EXTENSION = /\.(?:gif|jpe?g|tiff?|png|webp|bmp|tga|psd|ai)$/i;
const MARKDOWN_LINK = /^\[[^\]]*\]\((?:<)?([^\s<>]+)(?:>)?\)$/;

export function isMarkdownLinkAlready(editor: Editor): boolean {
  const position = editor.getCursor("from");
  if (position.ch < 2) return false;
  return (
    editor.getRange({ line: position.line, ch: position.ch - 2 }, position) ===
    "]("
  );
}

export function isAfterQuote(editor: Editor): boolean {
  const position = editor.getCursor("from");
  if (position.ch < 1) return false;
  const previous = editor.getRange(
    { line: position.line, ch: position.ch - 1 },
    position,
  );
  return previous === '"' || previous === "'";
}

export function isUrl(text: string): boolean {
  return normalizeWebUrl(text) !== null;
}

export function isImage(text: string): boolean {
  try {
    return IMAGE_EXTENSION.test(
      parseWebUrl(normalizeWebUrl(text) ?? text).pathname,
    );
  } catch {
    return false;
  }
}

export function isLinkedUrl(text: string): boolean {
  const match = MARKDOWN_LINK.exec(text);
  return match !== null && normalizeWebUrl(match[1]) !== null;
}

export function isInCode(editor: Editor): boolean {
  const content = editor.getValue();
  const index = getIndexFromEditorPosition(content, editor.getCursor("from"));
  return isPositionInCode(content, index);
}

export function normalizeWebUrl(text: string): string | null {
  const candidate = text.startsWith("www.") ? `https://${text}` : text;
  try {
    parseWebUrl(candidate);
    return candidate;
  } catch {
    return null;
  }
}

export function isPositionInCode(content: string, index: number): boolean {
  const safeIndex = Math.max(0, Math.min(index, content.length));
  const lineStart = content.lastIndexOf("\n", safeIndex - 1) + 1;
  const currentLineIndex = content.slice(0, lineStart).split("\n").length - 1;
  const nextLineBreak = content.indexOf("\n", safeIndex);
  const currentLine = content.slice(
    lineStart,
    nextLineBreak < 0 ? content.length : nextLineBreak,
  );
  const cursorInLine = safeIndex - lineStart;

  let fence: { character: "`" | "~"; length: number } | null = null;
  const lines = content.split("\n");
  for (let lineIndex = 0; lineIndex < currentLineIndex; lineIndex++) {
    fence = updateFence(fence, lines[lineIndex], lines[lineIndex].length);
  }

  const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(currentLine);
  if (fence) {
    if (
      fenceMatch &&
      isClosingFence(fence, fenceMatch[1], fenceMatch[2]) &&
      cursorInLine >= currentLine.length - fenceMatch[2].length
    ) {
      fence = null;
    }
    if (fence) return true;
  } else if (
    fenceMatch &&
    cursorInLine >= fenceMatch[0].length - fenceMatch[2].length
  ) {
    return true;
  }

  return isInInlineCode(currentLine, cursorInLine);
}

function updateFence(
  current: { character: "`" | "~"; length: number } | null,
  line: string,
  cursor: number,
): { character: "`" | "~"; length: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return current;
  if (!current) {
    return {
      character: match[1][0] as "`" | "~",
      length: match[1].length,
    };
  }
  if (
    isClosingFence(current, match[1], match[2]) &&
    cursor >= match[0].length - match[2].length
  ) {
    return null;
  }
  return current;
}

function isClosingFence(
  fence: { character: "`" | "~"; length: number },
  run: string,
  trailing: string,
): boolean {
  return (
    run[0] === fence.character &&
    run.length >= fence.length &&
    /^\s*$/.test(trailing)
  );
}

function isInInlineCode(line: string, cursor: number): boolean {
  const runs = [...line.matchAll(/`+/g)].filter((match) => {
    let slashCount = 0;
    for (
      let index = match.index - 1;
      index >= 0 && line[index] === "\\";
      index--
    ) {
      slashCount++;
    }
    return slashCount % 2 === 0;
  });

  for (let openIndex = 0; openIndex < runs.length; openIndex++) {
    const opening = runs[openIndex];
    const closeIndex = runs.findIndex(
      (candidate, index) =>
        index > openIndex && candidate[0].length === opening[0].length,
    );
    if (closeIndex < 0) continue;
    const openEnd = opening.index + opening[0].length;
    const closeStart = runs[closeIndex].index;
    if (cursor > openEnd && cursor < closeStart) return true;
    openIndex = closeIndex;
  }
  return false;
}
