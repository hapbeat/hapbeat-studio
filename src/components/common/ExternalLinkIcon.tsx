/**
 * ExternalLinkIcon — 外部リンク用の「箱 + 右上矢印」アイコン。
 *
 * devtools-site (Header.astro の Studio CTA) と同じ SVG 形状で統一。
 * `target="_blank"` のリンク末尾に並べて使う:
 *
 *     <a href="..." target="_blank" rel="noopener noreferrer">
 *       Docs <ExternalLinkIcon />
 *     </a>
 *
 * サイズは `1em` で親フォントに追従。色は `currentColor`。
 */
export function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 14 14"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ verticalAlign: '-0.15em' }}
    >
      <line x1="5" y1="9" x2="13" y2="1" />
      <polyline points="8.5,1 13,1 13,5.5" />
      <path d="M7,1.5 H2.5 C1.67,1.5 1,2.17 1,3 V11.5 C1,12.33 1.67,13 2.5,13 H11.5 C12.33,13 13,12.33 13,11.5 V8" />
    </svg>
  )
}
