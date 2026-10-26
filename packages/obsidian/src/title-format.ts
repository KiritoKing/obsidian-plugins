import { parseWebUrl } from "@chlrc/browser-profile-title-protocol";

const MARKDOWN_TITLE_PUNCTUATION =
  /\\|`|\*|_|\{|\}|\[|\]|\(|\)|#|\+|\.|!|\||<|>|~|-/g;

export function cleanTitle(title: string, maximumLength = 0): string {
  const normalized = Array.from(title, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return isControlOrInvisible(codePoint) ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();

  if (!maximumLength || normalized.length <= maximumLength + 3)
    return normalized;
  return `${normalized.slice(0, maximumLength)}...`;
}

function isControlOrInvisible(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff
  );
}

export function escapeMarkdownTitle(title: string): string {
  return cleanTitle(title).replace(MARKDOWN_TITLE_PUNCTUATION, "\\$&");
}

export function formatMarkdownLink(title: string, url: string): string {
  const destination = parseWebUrl(url).href.replace(/[<>\s]/g, (character) =>
    encodeURIComponent(character),
  );
  return `[${escapeMarkdownTitle(title)}](<${destination}>)`;
}

export function resolvedTitleReplacement(
  title: string,
  url: string,
  maximumLength = 0,
): string | null {
  const safeTitle = cleanTitle(title, maximumLength);
  return safeTitle ? formatMarkdownLink(safeTitle, url) : null;
}

export function safeReplacementRange(
  currentValue: string,
  expectedValue: string,
  startIndex: number,
  expectedText: string,
): { start: number; end: number } | null {
  if (currentValue !== expectedValue || startIndex < 0) return null;
  const end = startIndex + expectedText.length;
  if (currentValue.slice(startIndex, end) !== expectedText) return null;
  return { start: startIndex, end };
}
