// Pure helpers for the Gilded Quill MCP server (no network, no SDK), so they can be tested alone.

/** A sentence for a failed API call, written for the model reading it (what happened and what to try). */
export function apiError(status, body, what = 'the request') {
  const said = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : '';
  switch (status) {
    case 0:
      return `Could not reach the Gilded Quill server. Is QUILL_URL right and the server running? (${said || 'no answer'})`;
    case 401:
      return 'The access token was not accepted: it is wrong, expired or revoked. Make a new one in the app (Profile → Security → Access tokens) and set QUILL_TOKEN.';
    case 403:
      return `Not allowed. Either this access token is read-only (make one with “Allow editing”), or your role in this scroll does not permit it (readers cannot change a scroll).${said ? ` Server said: ${said}` : ''}`;
    case 404:
      return `Not found, or you have no access to it: check the scroll id and the file path (use list_scrolls and get_scroll). ${said}`.trim();
    case 409:
      return said || `${what} conflicts with the current state of the scroll.`;
    case 429:
      return 'Too many requests. Wait a little and try again.';
    default:
      return said || `${what} failed (HTTP ${status}).`;
  }
}

/** Number the lines of `text` the way an editor does, starting at `first`: "  12 | text". */
export function numberLines(text, first = 1) {
  if (text === '') return '';
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  const width = String(first + lines.length - 1).length;
  return lines.map((l, i) => `${String(first + i).padStart(width)} | ${l}`).join('\n');
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The RegExp for a search, or an error message for a pattern that does not parse. */
export function buildMatcher(query, { regex = false, caseSensitive = false, wholeWord = false } = {}) {
  if (!query) return { error: 'The query is empty.' };
  let source = regex ? query : escapeRegex(query);
  if (wholeWord) source = `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])`;
  try {
    return { re: new RegExp(source, `gm${caseSensitive ? '' : 'i'}`) };
  } catch {
    return { error: 'That is not a valid regular expression.' };
  }
}

/** Find `query` in the given files: matches with file, line, column and the line itself. */
export function searchTexts(files, query, options = {}, max = 50) {
  const { re, error } = buildMatcher(query, options);
  if (!re) return { error, hits: [], total: 0, truncated: false };
  const hits = [];
  let total = 0;
  for (const { path, text } of files) {
    const lines = text.split('\n');
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      for (let m = re.exec(lines[i]); m; m = re.exec(lines[i])) {
        if (m[0] === '') {
          re.lastIndex++;
          continue;
        }
        total++;
        if (hits.length < max) hits.push({ path, line: i + 1, column: m.index + 1, text: lines[i].length > 200 ? `${lines[i].slice(0, 200)}…` : lines[i] });
      }
      offset += lines[i].length + 1;
    }
  }
  return { hits, total, truncated: total > hits.length };
}

/** The outcome of a compile as plain text: errors first with file and line, then warnings, then the end of the log. */
export function describeCompile(result, tailLines = 25) {
  const out = [];
  out.push(result.ok ? `Compiled successfully in ${result.durationMs} ms.` : `Compilation FAILED after ${result.durationMs} ms.`);
  const diags = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  const where = (d) => (d.file ? `${d.file}${d.line ? `:${d.line}` : ''}` : 'unknown location');
  const errors = diags.filter((d) => d.severity === 'error');
  const warnings = diags.filter((d) => d.severity !== 'error');
  if (errors.length) out.push('', `Errors (${errors.length}):`, ...errors.slice(0, 20).map((d) => `  ${where(d)}: ${d.message}`));
  if (warnings.length) out.push('', `Warnings (${warnings.length}):`, ...warnings.slice(0, 10).map((d) => `  ${where(d)}: ${d.message}`));
  if (!result.ok && typeof result.log === 'string' && result.log.trim()) {
    const tail = result.log.trimEnd().split('\n').slice(-tailLines);
    out.push('', `End of the log:`, ...tail.map((l) => `  ${l}`));
  }
  return out.join('\n');
}

/** A short line about a queued edit, for the model. */
export function describeQueued(body) {
  return `QUEUED, NOT APPLIED: this scroll holds assistants' edits for review. A person must accept proposal ${body.proposalId} in the app before it is in the document. You can check it with get_proposal_status. Do not assume the change exists until it is accepted.`;
}
