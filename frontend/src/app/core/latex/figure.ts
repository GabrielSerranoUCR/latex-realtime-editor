/** Pure helpers for binary project files (images, PDFs) and the LaTeX that includes them. */

export interface AssetInfo {
  path: string;
  size: number;
  mime: string;
  sha256: string;
}

/** What the server accepts, mirrored for early feedback (the server remains the authority). */
export const ASSET_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'eps'] as const;
export const ACCEPT_ATTR = ASSET_EXTENSIONS.map((e) => '.' + e).join(',');
/** Data type for dragging a picture that is already in the hall into the document. */
export const ASSET_DRAG_TYPE = 'application/x-quill-asset';
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;

export const extOf = (path: string): string => (path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '');
export const isAssetName = (name: string): boolean => (ASSET_EXTENSIONS as readonly string[]).includes(extOf(name));
/** Browsers can show these inline; pdf/eps get a placeholder card. */
export const isPreviewableImage = (mime: string): boolean => /^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(mime);
/** `graphicx` (pdfLaTeX/XeTeX/Tectonic) cannot embed svg or webp directly. */
export const isLatexIncludable = (path: string): boolean => ['png', 'jpg', 'jpeg', 'pdf', 'eps'].includes(extOf(path));

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Turn an uploaded file's name into a safe project path under `figures/`, avoiding clashes with
 * existing files (`orbit.png` -> `figures/orbit-2.png`).
 */
export function suggestAssetPath(fileName: string, taken: readonly string[]): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[^\w\- ]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  const used = new Set(taken);
  let path = `figures/${stem}.${ext}`;
  for (let i = 2; used.has(path); i++) path = `figures/${stem}-${i}.${ext}`;
  return path;
}

/** Early client-side check; returns a message or null. */
export function checkUpload(file: { name: string; size: number }): string | null {
  if (!isAssetName(file.name)) return `“${file.name}” is not supported (png, jpg, gif, webp, svg, pdf, eps).`;
  if (file.size === 0) return `“${file.name}” is empty.`;
  if (file.size > MAX_ASSET_BYTES) return `“${file.name}” is larger than ${MAX_ASSET_BYTES / 1024 / 1024} MB.`;
  return null;
}

const escapeLatex = (s: string): string => s.replace(/([&%$#_{}])/g, '\\$1').replace(/\\(?![&%$#_{}])/g, '\\textbackslash{}');

export type FigureAlign = 'left' | 'centre' | 'right';
export type FigurePlace = 'h' | 't' | 'b' | 'p';
export type WidthUnit = '\\textwidth' | '\\linewidth' | 'cm';

export interface FigureOptions {
  path: string;
  /** Width in `unit`s (a fraction of the line for the `\…width` units, centimetres for `cm`); `null` = original size. */
  width: number | null;
  unit?: WidthUnit;
  /** Wrap in a floating `figure` environment (default) or emit a bare `\includegraphics`. */
  float?: boolean;
  align?: FigureAlign;
  /** Placement specifiers in the order h, t, b, p. */
  placement?: readonly FigurePlace[];
  caption?: string;
  /** Entry for the list of figures: `\caption[short]{long}`. */
  shortCaption?: string;
  label?: string;
}

export function widthArg(width: number | null, unit: WidthUnit = '\\textwidth'): string {
  if (width === null) return '';
  const w = unit === 'cm' ? Math.min(40, Math.max(0.5, width)) : Math.min(1, Math.max(0.1, width));
  return `[width=${+w.toFixed(2)}${unit === 'cm' ? 'cm' : unit}]`;
}

/** Slug usable as a `\label` key. */
export const labelFor = (path: string): string => 'fig:' + (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function figureSnippet(o: FigureOptions): string {
  const include = `\\includegraphics${widthArg(o.width, o.unit)}{${o.path}}`;
  const align = { left: '\\raggedright', centre: '\\centering', right: '\\raggedleft' }[o.align ?? 'centre'];
  if (o.float === false) return [`{${align}`, `  ${include}`, '}', ''].join('\n');
  const order: FigurePlace[] = ['h', 't', 'b', 'p'];
  const spec = order.filter((p) => o.placement?.includes(p)).join('') || 'htbp';
  const caption = o.caption?.trim();
  const short = o.shortCaption?.trim();
  const label = o.label?.trim();
  const lines = [`\\begin{figure}[${spec}]`, `  ${align}`, `  ${include}`];
  if (caption) lines.push(`  \\caption${short ? `[${escapeLatex(short)}]` : ''}{${escapeLatex(caption)}}`);
  if (label) lines.push(`  \\label{${label}}`);
  lines.push('\\end{figure}', '');
  return lines.join('\n');
}

/** Whether the document already loads graphicx (so the dialog can warn). */
export const hasGraphicx = (source: string): boolean => /\\usepackage(\[[^\]]*\])?\{[^}]*\bgraphicx\b[^}]*\}/.test(source);
