/** Static LaTeX vocabulary for autocompletion. Templates use CodeMirror snippet syntax: ${name}. */

export interface CommandDef {
  /** Command name without the leading backslash. */
  name: string;
  /** Snippet template after the backslash; defaults to just the name. */
  snippet?: string;
  detail?: string;
  /** Text inserted on accept (after the backslash). Default: name plus the first `{` if it takes arguments. */
  open?: string;
  /** Insert the whole template (all arguments, as tab-able placeholders). Default: every command with a template that is not inline. */
  full?: boolean;
  /** Force (or forbid) inline closing: `\\cmd{}` with the caret inside. Default: single-argument commands. */
  inline?: boolean;
}

const c = (name: string, snippet?: string, detail?: string, open?: string): CommandDef => ({ name, snippet, detail, open });
/** A verbose command: accepting it inserts the complete template. */
const v = (name: string, snippet: string, detail?: string): CommandDef => ({ name, snippet, detail, full: true });

/**
 * A command with exactly one `{...}` argument (`\\textbf{}`, `\\section{}`, `\\ref{}`) is "inline":
 * accepting it closes the bracket too and leaves the caret inside.
 */
export function isInlineCommand(d: CommandDef): boolean {
  if (d.inline !== undefined) return d.inline;
  if (d.full || d.open !== undefined || !d.snippet) return false;
  const bare = d.snippet.replace(/\$\{[^}]*\}/g, ''); // drop placeholders, leave real brackets
  return (bare.match(/\{/g) ?? []).length === 1 && !/[\^_]\{/.test(bare);
}

/**
 * Commands with a template (several arguments, or sub/superscripts) insert all of it as
 * tab-able placeholders: `\\frac{num}{den}`. Containers whose argument is something you choose
 * (`\\begin`) are inline and take the staged flow instead.
 */
export function insertsFullTemplate(d: CommandDef): boolean {
  if (d.full !== undefined) return d.full;
  return !!d.snippet && !isInlineCommand(d);
}

/** Fallback for commands without a template: just the name (or an explicit `open`). */
export function commandOpening(d: CommandDef): string {
  if (d.open !== undefined) return d.open;
  const s = d.snippet;
  if (!s) return d.name;
  const brace = s.indexOf('{');
  const field = s.indexOf('${');
  // `item ${}` has no bracket; `{` that belongs to a field (`${x}`) is not a real bracket
  if (brace < 0 || (field >= 0 && field < brace)) return s.slice(0, field >= 0 ? field : s.length);
  return s.slice(0, brace + 1);
}

export const COMMANDS: CommandDef[] = [
  // structure
  c('documentclass', 'documentclass{${article}}'), c('usepackage', 'usepackage{${}}'), c('title', 'title{${}}'), c('author', 'author{${}}'),
  c('date', 'date{${\\today}}'), c('maketitle'), c('tableofcontents'), c('appendix'), c('part', 'part{${}}'), c('chapter', 'chapter{${}}'),
  c('section', 'section{${}}', 'heading'), c('subsection', 'subsection{${}}', 'heading'), c('subsubsection', 'subsubsection{${}}', 'heading'),
  c('paragraph', 'paragraph{${}}'), c('section*', 'section*{${}}', 'unnumbered'), c('subsection*', 'subsection*{${}}', 'unnumbered'),
  { ...c('begin', 'begin{${env}}\n\t${}\n\\end{${env}}', 'environment'), inline: true }, c('end', 'end{${env}}'),
  c('input', 'input{${}}'), c('include', 'include{${}}'), c('bibliography', 'bibliography{${refs}}'), c('bibliographystyle', 'bibliographystyle{${plain}}'),
  c('printbibliography'), c('addbibresource', 'addbibresource{${refs.bib}}'),
  // text
  c('textbf', 'textbf{${}}', 'bold'), c('textit', 'textit{${}}', 'italic'), c('texttt', 'texttt{${}}', 'monospace'), c('textsc', 'textsc{${}}', 'small caps'),
  c('textrm', 'textrm{${}}'), c('textsf', 'textsf{${}}'), c('emph', 'emph{${}}', 'emphasis'), c('underline', 'underline{${}}'), c('footnote', 'footnote{${}}'),
  v('textcolor', 'textcolor{${red}}{${text}}', 'colour template'), c('url', 'url{${}}'), v('href', 'href{${url}}{${text}}', 'link template'), c('item', 'item ${}'), c('caption', 'caption{${}}'),
  c('label', 'label{${}}'), c('ref', 'ref{${}}', 'cross-reference'), c('eqref', 'eqref{${}}', '(n) equation ref'), c('autoref', 'autoref{${}}'),
  c('cref', 'cref{${}}', 'cleveref'), c('Cref', 'Cref{${}}', 'cleveref'), c('pageref', 'pageref{${}}'),
  c('cite', 'cite{${}}', 'citation'), c('citep', 'citep{${}}', 'natbib (Author, year)'), c('citet', 'citet{${}}', 'natbib Author (year)'),
  v('includegraphics', 'includegraphics[width=${0.8\\linewidth}]{${path}}', 'image template'),
  v('newcommand', 'newcommand{\\${name}}{${definition}}', 'macro template'), v('renewcommand', 'renewcommand{\\${name}}{${definition}}', 'macro template'), v('newtheorem', 'newtheorem{${thm}}{${Theorem}}', 'theorem template'),
  c('centering'), c('noindent'), c('newpage'), c('clearpage'), c('par'), c('today'), c('hfill'), c('vfill'), c('linebreak'), c('pagebreak'),
  c('vspace', 'vspace{${1em}}'), c('hspace', 'hspace{${1em}}'), c('quad'), c('qquad'), c('hline'), c('toprule'), c('midrule'), c('bottomrule'),
  v('multicolumn', 'multicolumn{${ncols}}{${c}}{${text}}', 'table template'), v('multirow', 'multirow{${nrows}}{*}{${text}}', 'table template'), c('tiny'), c('small'), c('large'), c('Large'), c('LARGE'), c('huge'), c('normalsize'),
  // math
  c('frac', 'frac{${num}}{${den}}', 'fraction'), c('tfrac', 'tfrac{${}}{${}}'), c('dfrac', 'dfrac{${}}{${}}'), c('sqrt', 'sqrt{${}}'), c('binom', 'binom{${n}}{${k}}'),
  c('sum', 'sum_{${i=1}}^{${n}}'), c('prod', 'prod_{${i=1}}^{${n}}'), c('int', 'int_{${a}}^{${b}} ${} \\,d${x}'), c('oint'), c('lim', 'lim_{${x \\to 0}}'),
  c('partial'), c('nabla'), c('infty', undefined, '∞'), c('cdot', undefined, '·'), c('cdots', undefined, '⋯'), c('ldots', undefined, '…'), c('times', undefined, '×'),
  c('leq', undefined, '≤'), c('geq', undefined, '≥'), c('neq', undefined, '≠'), c('approx', undefined, '≈'), c('equiv', undefined, '≡'), c('sim', undefined, '∼'),
  c('propto', undefined, '∝'), c('in', undefined, '∈'), c('notin', undefined, '∉'), c('subset', undefined, '⊂'), c('subseteq', undefined, '⊆'), c('cup', undefined, '∪'),
  c('cap', undefined, '∩'), c('forall', undefined, '∀'), c('exists', undefined, '∃'), c('to', undefined, '→'), c('rightarrow', undefined, '→'), c('leftarrow', undefined, '←'),
  c('Rightarrow', undefined, '⇒'), c('Leftarrow', undefined, '⇐'), c('leftrightarrow', undefined, '↔'), c('Leftrightarrow', undefined, '⇔'), c('mapsto', undefined, '↦'),
  c('pm', undefined, '±'), c('mp', undefined, '∓'), c('hbar', undefined, 'ℏ'), c('ell', undefined, 'ℓ'), c('angle', undefined, '∠'), c('perp', undefined, '⊥'),
  c('mathbb', 'mathbb{${R}}', 'blackboard'), c('mathcal', 'mathcal{${}}', 'calligraphic'), c('mathbf', 'mathbf{${}}', 'bold math'), c('mathrm', 'mathrm{${}}', 'roman math'),
  c('mathit', 'mathit{${}}'), c('mathfrak', 'mathfrak{${}}'), c('text', 'text{${}}', 'text in math'), c('vec', 'vec{${}}'), c('hat', 'hat{${}}'), c('bar', 'bar{${}}'),
  c('dot', 'dot{${}}'), c('ddot', 'ddot{${}}'), c('tilde', 'tilde{${}}'), c('overline', 'overline{${}}'), c('widehat', 'widehat{${}}'),
  c('left', 'left( ${} \\right)', 'paired delimiters'), c('right'), c('langle', undefined, '⟨'), c('rangle', undefined, '⟩'), c('lVert'), c('rVert'), c('norm', 'norm{${}}'),
  c('sin'), c('cos'), c('tan'), c('log'), c('ln'), c('exp'), c('max'), c('min'), c('det'), c('dim'), c('ker'), c('arg'), c('operatorname', 'operatorname{${}}'),
  c('underbrace', 'underbrace{${}}_{${}}'), c('overbrace', 'overbrace{${}}^{${}}'), c('xrightarrow', 'xrightarrow{${}}'), c('quad'),
];

// Greek letters, with their glyph as the completion detail.
const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ',
  varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
for (const [name, glyph] of Object.entries(GREEK)) COMMANDS.push(c(name, undefined, glyph));

export interface EnvDef {
  name: string;
  /** Extra text right after `\\begin{name}` (arguments), as a snippet. */
  args?: string;
  /**
   * Everything between the arguments and `\\end{name}`, as a snippet. Use `\t` per indent level.
   * Default: one empty indented line. Environments with a body are "verbose": closing them
   * writes the whole template.
   */
  body?: string;
  detail?: string;
}
const e = (name: string, args?: string, detail?: string, body?: string): EnvDef => ({ name, args, detail, body });

const LB = '\\\\'; // a LaTeX line break `\\`
const ALIGN_BODY = '\n\t${lhs} &= ${rhs} ' + LB + '\n\t${} &= ${}\n';
const MATRIX_BODY = '\n\t${} & ${} ' + LB + '\n\t${} & ${}\n';
const TABLE_BODY =
  '\n\t\\centering\n\t\\caption{${caption}}\n\t\\label{tab:${label}}\n\t\\begin{tabular}{${ll}}\n' +
  '\t\t\\toprule\n\t\t${A} & ${B} ' + LB + '\n\t\t\\midrule\n\t\t${} & ${} ' + LB + '\n\t\t\\bottomrule\n\t\\end{tabular}\n';

export const ENVIRONMENTS: EnvDef[] = [
  e('document'), e('abstract'),
  e('itemize', undefined, 'bullets', '\n\t\\item ${}\n'),
  e('enumerate', undefined, 'numbered', '\n\t\\item ${}\n'),
  e('description', undefined, undefined, '\n\t\\item[${term}] ${}\n'),
  e('equation', undefined, 'numbered'), e('equation*', undefined, 'unnumbered'),
  e('align', undefined, 'aligned, numbered', ALIGN_BODY),
  e('align*', undefined, 'aligned', ALIGN_BODY),
  e('gather'), e('gather*'), e('multline'), e('multline*'), e('split'), e('cases'), e('subequations'), e('array', '{${cc}}'),
  e('matrix', undefined, undefined, MATRIX_BODY),
  e('pmatrix', undefined, '( )', MATRIX_BODY),
  e('bmatrix', undefined, '[ ]', MATRIX_BODY),
  e('vmatrix', undefined, '| |'), e('Bmatrix'), e('Vmatrix'),
  e('figure', '[${htbp}]', 'float template',
    '\n\t\\centering\n\t\\includegraphics[width=${0.8\\linewidth}]{${path}}\n\t\\caption{${caption}}\n\t\\label{fig:${label}}\n'),
  e('table', '[${htbp}]', 'float template', TABLE_BODY),
  e('tabular', '{${ll}}', undefined, '\n\t${} & ${} ' + LB + '\n'),
  e('longtable', '{${ll}}'), e('center'), e('flushleft'), e('flushright'),
  e('quote'), e('quotation'), e('verbatim'),
  e('lstlisting', '[language=${Python}]', 'code listing', '\n${}\n'), e('minted', '{${python}}', 'code listing', '\n${}\n'),
  e('minipage', '{${0.5\\linewidth}}'),
  e('theorem'), e('lemma'), e('proposition'), e('corollary'), e('definition'), e('remark'), e('example'), e('proof'),
  e('thebibliography', '{99}', undefined, '\n\t\\bibitem{${key}} ${}\n'),
  e('tikzpicture'), e('frame', '{${Title}}', 'beamer slide'), e('columns'), e('column', '{${0.5\\textwidth}}'),
  e('algorithm', undefined, 'algorithm template',
    '\n\t\\caption{${caption}}\n\t\\label{alg:${label}}\n\t\\begin{algorithmic}[1]\n\t\t\\State ${}\n\t\\end{algorithmic}\n'),
  e('algorithmic'),
];

export const PACKAGES: string[] = [
  'amsmath', 'amssymb', 'amsthm', 'mathtools', 'physics', 'braket', 'graphicx', 'hyperref', 'geometry', 'babel', 'inputenc', 'fontenc', 'xcolor', 'tikz', 'pgfplots',
  'booktabs', 'array', 'longtable', 'multirow', 'caption', 'subcaption', 'float', 'listings', 'minted', 'siunitx', 'biblatex', 'natbib', 'cleveref', 'enumitem',
  'fancyhdr', 'setspace', 'microtype', 'lmodern', 'algorithm', 'algpseudocode', 'algorithm2e', 'url', 'csquotes', 'todonotes', 'titlesec', 'tocloft', 'lipsum',
  'etoolbox', 'ifthen', 'verbatim', 'parskip', 'appendix', 'glossaries', 'tcolorbox', 'bm', 'cancel', 'xspace', 'pdfpages', 'wrapfig', 'epstopdf', 'textcomp',
];

export const DOCUMENT_CLASSES: string[] = ['article', 'report', 'book', 'letter', 'beamer', 'memoir', 'amsart', 'IEEEtran', 'scrartcl', 'scrreprt', 'scrbook', 'standalone'];

export const IMAGE_EXTENSIONS = /\.(png|jpe?g|pdf|svg|eps)$/i;
export const TEX_EXTENSIONS = /\.(tex|sty|cls)$/i;
