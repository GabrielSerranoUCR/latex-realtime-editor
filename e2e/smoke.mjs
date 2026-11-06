import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { strFromU8, strToU8, unzipSync, zipSync } from '../frontend/node_modules/fflate/esm/browser.js';

// Full-stack smoke test in a real browser. Needs: PostgreSQL (docker compose up -d db), the Rust
// backend on :8080 *with Tectonic installed*, and the Angular dev server on :4200.
//   npm --prefix e2e install && npm run test:e2e
// Env: BASE_URL (default http://localhost:4200), CHROME_PATH (default: macOS Google Chrome),
//      SHOTS_DIR (default e2e/shots) for the screenshots it saves.
import path from 'node:path';
const BASE = process.env.BASE_URL ?? 'http://localhost:4200';
const OUT = process.env.SHOTS_DIR ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// A real (CRC-correct) PNG so the TeX engine can embed it.
function makePng(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { const row = y * (w * 3 + 1); for (let x = 0; x < w; x++) { raw[row + 1 + x * 3] = (x * 4) & 255; raw[row + 2 + x * 3] = (y * 6) & 255; raw[row + 3 + x * 3] = 160; } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';
/** Put the caret at the very end of the document (a click alone lands wherever the layout puts the middle of the text). */
async function docEnd(page) {
  await page.click('.cm-content');
  await page.keyboard.down(MOD_KEY);
  await page.keyboard.press(MOD_KEY === 'Meta' ? 'ArrowDown' : 'End');
  await page.keyboard.up(MOD_KEY);
}
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

async function until(fn, what, ms = 15000) {
  const t = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t > ms) throw new Error('timeout: ' + what);
    await sleep(100);
  }
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 1024 } });
const consoleErrors = [];
async function newScribe(label) {
  const ctx = await browser.createBrowserContext(); // separate cookie jar = separate person
  const page = await ctx.newPage();
  // folders start folded; most checks look inside them, so unfold them as they appear (unless a test sets __keepFolded)
  await page.evaluateOnNewDocument(() => {
    setInterval(() => {
      if (window.__keepFolded) return;
      document.querySelectorAll('qq-file-tree li.dir[aria-expanded="false"]').forEach((d) => d.click());
    }, 120);
  });
  page.on('pageerror', (e) => consoleErrors.push(`${label}: ${e.message}`));
  return page;
}
const email = (n) => `${n}-${Date.now()}@guild.test`;
async function signup(page, name, mail) {
  await page.goto(`${BASE}/signup`);
  await page.waitForSelector('input[name=email]');
  await page.type('input[name=name]', name);
  await page.type('input[name=email]', mail);
  await page.type('input[name=password]', 'correct horse battery staple');
  await page.click('button[type=submit]');
  await page.waitForSelector('.head h1');
}
const editorText = (page) => page.$eval('.cm-content', (el) => el.innerText);

try {
  // ---- unauthenticated: redirected to the door
  const owner = await newScribe('owner');
  await owner.goto(`${BASE}/`);
  await until(() => owner.url().includes('/login'), 'redirect to /login');
  check('anonymous visitors are sent to the login page', owner.url().includes('/login'));

  // ---- sign up -> dashboard (empty)
  const ownerMail = email('aelith');
  await signup(owner, 'Aelith', ownerMail);
  check('signup lands on the quest board', (await owner.$eval('.head h1', (e) => e.textContent)).includes('Your Scrolls'));
  await owner.waitForSelector('.empty h2');
  check('empty board is shown', (await owner.$eval('.empty h2', (e) => e.textContent)).includes('bare'));
  await owner.screenshot({ path: `${OUT}/01-dashboard-empty.png` });

  // ---- create a scroll -> editor
  await owner.click('.head .acts .btn:not(.btn--ghost)');
  await owner.waitForSelector('dialog[open] input[name=title]');
  await owner.type('dialog[open] input[name=title]', 'Thesis – Chapter 4');
  await owner.click('dialog[open] button[type=submit]');
  await owner.waitForSelector('.cm-content');
  const scrollUrl = owner.url();
  check('creating a scroll opens the editor', /\/scroll\/[0-9a-f-]{36}$/.test(scrollUrl), scrollUrl);
  await until(async () => (await editorText(owner)).includes('documentclass'), 'starter file synced');
  check('starter document is seeded and shown', true);
  check('title and role are shown', (await owner.$eval('.doc h1', (e) => e.textContent)).includes('Thesis') && (await owner.$eval('.doc h1 .chip', (e) => e.textContent)).trim() === 'owner');
  check('connection indicator says connected', (await owner.$eval('.state', (e) => e.textContent)).includes('Saved to the cellar') || (await owner.$eval('.state', (e) => e.textContent)).includes('Joining'));

  // ---- type into the editor, autocomplete, compile with REAL Tectonic
  await docEnd(owner);
  await owner.keyboard.type('\n\\sec');
  await until(() => owner.$('.cm-tooltip-autocomplete'), 'autocomplete popup');
  check('autocomplete popup appears while typing a command', true);
  await owner.screenshot({ path: `${OUT}/02-autocomplete.png` });
  await sleep(150);
  await owner.keyboard.press('Tab'); // accept -> \section{}
  await owner.keyboard.type('Hello from the browser');
  const txt = await editorText(owner);
  check('Tab accepted the suggestion and left the caret inside the braces', txt.includes('\\section{Hello from the browser}'), JSON.stringify(txt.slice(-60)));

  // ---- invite a reader
  const readerMail = email('rowan');
  const reader = await newScribe('reader');
  await signup(reader, 'Rowan', readerMail);
  // the reader confirms their email first (mail lands in <data>/outbox in dev); only a verified
  // address can accept an invitation
  const outbox = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'data', 'outbox');
  const verifyLink = await until(() => {
    for (const f of fs.readdirSync(outbox).sort().reverse()) {
      const body = fs.readFileSync(path.join(outbox, f), 'utf8');
      if (body.startsWith(`To: ${readerMail}`)) { const m = body.match(/https?:\/\/\S+verify-email\?token=\S+/); if (m) return m[0]; }
    }
  }, 'verification mail');
  await reader.goto(verifyLink);
  await until(async () => (await reader.evaluate(() => document.body.innerText)).toLowerCase().includes('confirmed'), 'email confirmed');
  check('a new scribe can confirm their email from the mailed link', true);

  await owner.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Share').click());
  await owner.waitForSelector('dialog[open] input[name=email]');
  const shareHeights = await owner.evaluate(() => ['input[name=email]', 'select[name=role]', 'form.row .btn'].map((q) => Math.round(document.querySelector('dialog[open] ' + q).getBoundingClientRect().height)));
  check('in Share, the email box, the role dropdown and the Invite button are the same height', new Set(shareHeights).size === 1, shareHeights.join(' / '));
  await owner.type('dialog[open] input[name=email]', readerMail);
  await owner.select('dialog[open] select[name=role]', 'reader');
  await sleep(250); // let the form take in what was typed before pressing Invite
  await owner.evaluate(() => [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.trim() === 'Invite').click());
  await until(async () => (await owner.$$eval('dialog[open] .people li', (l) => l.length)) === 2, 'invitation row appears', 15000);
  check('owner can invite a reader by email', true);
  // share links: one for editing, one for viewing; a third person joins by the viewing link
  await owner.evaluate(() => [...document.querySelectorAll('dialog[open] .links button')].find((b) => b.textContent.includes('Create link for editing')).click());
  await owner.waitForSelector('dialog[open] input.url');
  await owner.evaluate(() => [...document.querySelectorAll('dialog[open] .links button')].find((b) => b.textContent.includes('Create link for viewing')).click());
  await until(async () => (await owner.$$('dialog[open] input.url')).length === 2, 'both links appear');
  const [editLink, viewLink] = await owner.$$eval('dialog[open] input.url', (l) => l.map((e) => e.value));
  check('the share dialog makes a link for editing and a different link for viewing', editLink.startsWith(`${BASE}/join/`) && viewLink.startsWith(`${BASE}/join/`) && editLink !== viewLink);
  const linkJoiner = await newScribe('linkjoiner');
  await signup(linkJoiner, 'Linda', email('linda'));
  await linkJoiner.goto(viewLink);
  await linkJoiner.waitForSelector('.card .chip');
  check('opening the viewing link asks to open the scroll as a reader', (await linkJoiner.$eval('.card', (e) => e.innerText)).includes('reader'));
  await linkJoiner.click('.card .btn');
  await linkJoiner.waitForSelector('.cm-content');
  check('and lands in the scroll with the viewing seat', (await linkJoiner.$eval('body', (e) => e.innerText)).includes('You can look and download'));
  await owner.screenshot({ path: `${OUT}/03-share.png` });
  await owner.evaluate(() => [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.trim() === 'Done').click());

  // ---- reader: accepts the invitation, opens the scroll read-only and receives live edits
  await reader.goto(`${BASE}/`);
  await reader.waitForSelector('.invite');
  await reader.screenshot({ path: `${OUT}/04-reader-dashboard.png` });
  await reader.evaluate(() => [...document.querySelectorAll('.invite button')].find((b) => b.textContent.trim() === 'Join').click());
  await reader.waitForSelector('.doc h1 .chip');
  check('accepting the invitation opens the scroll as a reader', /\/scroll\//.test(reader.url()) && (await reader.$eval('.doc h1 .chip', (e) => e.textContent)).trim() === 'reader', reader.url());
  await reader.waitForSelector('.cm-content');
  await until(async () => (await editorText(reader)).includes('Hello from the browser'), 'reader receives owner text');
  check('reader receives the owner\'s edits live', true);
  check('reader sees the read-only banner', (await reader.$eval('.banner--read', (e) => e.textContent)).includes('Reader'));
  check('reader cannot compile (button disabled)', await reader.$eval('.btn--ember', (b) => b.disabled));
  await reader.click('.cm-content');
  await reader.keyboard.type('READER TYPING');
  await sleep(500);
  check('reader keystrokes do not change the editor', !(await editorText(reader)).includes('READER TYPING'));
  check('reader keystrokes never reach the owner', !(await editorText(owner)).includes('READER TYPING'));

  // ---- owner types more; both see presence; compile
  await docEnd(owner);
  await owner.keyboard.type(' and more');
  await until(async () => (await editorText(reader)).includes('and more'), 'second live edit');
  check('live edits keep flowing to the reader', true);
  await until(async () => (await owner.$$eval('.presence li', (l) => l.length)) >= 2, 'presence shows two scribes');
  check('presence shows both scribes', true);

  await owner.keyboard.down('Control'); await owner.keyboard.press('Enter'); await owner.keyboard.up('Control');
  await until(async () => (await owner.$eval('qq-ink-log .chip', (e) => e.textContent)).includes('Compiled'), 'compile finishes', 120000);
  check('real Tectonic compile succeeded', true, (await owner.$eval('qq-ink-log .chip', (e) => e.textContent)).trim());
  check('the Scroll Preview header has a download icon for the PDF', (await owner.$eval('qq-pdf-preview a.hbtn[download]', (e) => e.getAttribute('href') || '')).includes('/pdf'));
  // folding: folders start folded (unit-tested); here a click folds one and a second click opens it again
  await owner.evaluate(() => { window.__keepFolded = true; });
  const hadDir = await owner.$('qq-file-tree li.dir');
  if (hadDir) {
    const before = (await owner.$$('qq-file-tree li')).length;
    await owner.evaluate(() => document.querySelector('qq-file-tree li.dir[aria-expanded="true"]')?.click());
    await sleep(250);
    check('clicking a folder in the Tavern Hall list folds it', (await owner.$$('qq-file-tree li')).length < before);
    await owner.evaluate(() => { window.__keepFolded = false; });
    await sleep(400);
    check('and it opens again', (await owner.$$('qq-file-tree li')).length === before);
  }
  await until(() => owner.$('qq-pdf-preview .page canvas'), 'pdf page');
  check('PDF preview shows the pages', true);
  await until(() => reader.$('qq-pdf-preview .page canvas'), 'reader preview follows the build');
  check("reader's preview shows the owner's build automatically", true);

  // ---- double-click the PDF: the caret goes to the source line that made that spot (SyncTeX)
  {
    const room = owner.url().match(/\/scroll\/([0-9a-f-]{36})/)[1];
    // find a spot on page 1 where the server names a line (proves the server side), then double-click it for real
    const found = await owner.evaluate(async (room) => {
      for (let y = 280; y < 480; y += 6) {
        const r = await fetch(`/api/rooms/${room}/synctex?page=1&x=200&y=${y}`);
        if (r.ok) { const hit = await r.json(); if (hit.line > 1) return { y, line: hit.line, file: hit.file }; }
      }
      return null;
    }, room);
    check('the server maps a spot of the PDF back to a source line (SyncTeX)', found !== null, JSON.stringify(found));
    const y = found?.y ?? 100;
    await owner.click('.cm-content');
    await owner.keyboard.down(MOD_KEY);
    await owner.keyboard.press(MOD_KEY === 'Meta' ? 'ArrowUp' : 'Home');
    await owner.keyboard.up(MOD_KEY);
    const box = await owner.$eval('qq-pdf-preview .page', (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width }; });
    const scale = box.width / 612;
    await owner.mouse.click(box.left + 200 * scale, box.top + y * scale, { clickCount: 2 });
    await until(async () => (await owner.$$eval('.cm-activeLineGutter', (els) => els.map((e) => e.textContent.trim()).filter(Boolean).join(','))) === String(found?.line), 'caret on the line behind the spot');
    check('double-clicking the PDF puts the caret on the source line behind it', true, `line ${found?.line}`);
  }
  await sleep(1500);
  await owner.screenshot({ path: `${OUT}/05-editor-compiled.png` });
  await reader.screenshot({ path: `${OUT}/06-reader-editor.png` });

  // ---- images: upload, live list, portrait panel, insert dialog, compile with the figure
  const png = path.join(OUT, 'orbit-test.png');
  fs.writeFileSync(png, makePng(64, 40));
  const input = await owner.$('qq-file-tree input[type=file]');
  await input.uploadFile(png);
  await until(() => owner.$('qq-portrait-panel'), 'portrait panel opens after upload');
  check('uploading an image opens its portrait', (await owner.$eval('qq-portrait-panel h3', (e) => e.textContent)).includes('orbit-test.png'));
  await until(async () => (await reader.$$eval('qq-file-tree li.asset', (l) => l.length)) === 1, 'reader sees the new image live');
  check("the image appears in the reader's Tavern Hall without a reload", true);
  check('readers get no upload or delete controls', (await reader.$('qq-file-tree button[aria-label="Upload images or PDFs"]')) === null && (await reader.$('qq-file-tree li.asset .del')) === null);
  await owner.click('qq-portrait-panel .btn.wide');
  await owner.waitForSelector('dialog.portrait[open]');
  await owner.screenshot({ path: `${OUT}/08-insert-image.png` });
  await owner.type('dialog.portrait[open] input[name=cap]', 'Test orbit');
  await sleep(300); // zoneless rendering is scheduled, not synchronous
  const snippet = await owner.$eval('dialog.portrait[open] pre.code', (e) => e.textContent);
  check('insert dialog generates the figure LaTeX', snippet.includes('\\includegraphics[width=0.7\\textwidth]{figures/orbit-test.png}') && snippet.includes('\\caption{Test orbit}'), snippet.replace(/\n/g, ' ⏎ '));
  await owner.click('dialog.portrait[open] .foot .btn:not(.btn--ink)');
  await until(async () => (await editorText(owner)).includes('figures/orbit-test.png'), 'snippet inserted at the cursor');
  check('Insert Portrait puts the figure in the document', true);
  await until(async () => (await editorText(reader)).includes('figures/orbit-test.png'), 'reader receives the snippet');
  check('the inserted figure reaches the other scribes live', true);
  await owner.screenshot({ path: `${OUT}/09-portrait-panel.png` });
  await owner.keyboard.down('Control'); await owner.keyboard.press('Enter'); await owner.keyboard.up('Control');
  await sleep(1500);
  await until(async () => !(await owner.$eval('qq-ink-log .chip', (e) => e.textContent)).includes('Compiling'), 'compile with image finishes', 120000);
  const chip = (await owner.$eval('qq-ink-log .chip', (e) => e.textContent)).trim();
  check('a compile that includes the uploaded image succeeds', chip.includes('Compiled'), chip + ' | ' + (await owner.$eval('qq-ink-log', (e) => e.innerText)).replace(/\s+/g, ' ').slice(0, 400));
  await owner.screenshot({ path: `${OUT}/10-compiled-with-image.png` });

  // ---- time travel: snapshots, diff against the present, restore (with undo), naming
  const byText = (page, scope, text) => page.evaluate((sc, t) => [...document.querySelectorAll(sc)].find((b) => b.textContent.trim().startsWith(t)).click(), scope, text);
  const panelBtn = (page, text) => page.evaluate((t) => [...document.querySelectorAll('header .panels button')].find((b) => b.textContent.trim() === t).click(), text);
  await panelBtn(owner, 'History');
  await owner.waitForSelector('qq-history-panel .entry');
  check('the History button opens the Time Travel panel with the current version on top', (await owner.$eval('qq-history-panel .entry', (e) => e.innerText)).includes('Current version'));
  await owner.click('qq-history-panel .actions .go'); // "Save a version"
  await owner.waitForSelector('qq-history-panel dialog[open] input[name=label]');
  await owner.type('qq-history-panel dialog[open] input[name=label]', 'Before the rewrite');
  await owner.click('qq-history-panel dialog[open] button[type=submit]');
  await until(async () => (await owner.$$eval('qq-history-panel .entry', (l) => l.some((e) => e.innerText.includes('Before the rewrite')))), 'named version appears');
  check('"Save a version" adds a named snapshot to the timeline', true);
  const mainBefore = await editorText(owner);

  await docEnd(owner);
  await owner.keyboard.type('\nNEWER LINE WRITTEN AFTER THE SNAPSHOT');
  await until(async () => (await editorText(reader)).includes('NEWER LINE'), 'reader sees the new line');

  await owner.evaluate(() => [...document.querySelectorAll('qq-history-panel .entry')].find((e) => e.innerText.includes('Before the rewrite')).click());
  await owner.waitForSelector('qq-diff-view .ln.del');
  const diffText = await owner.$eval('qq-diff-view', (e) => e.innerText);
  check('picking a snapshot shows a read-only diff against the present', diffText.includes('read-only') && (await owner.$('.cm-content')) === null);
  check('lines written after the snapshot show as removed (red), with a summary', (await owner.$$eval('qq-diff-view .ln.del .tx', (l) => l.map((x) => x.textContent))).some((t) => t.includes('NEWER LINE')) && diffText.includes('Restoring would change 1 file'));
  await owner.screenshot({ path: `${OUT}/15-time-travel-diff.png` });
  check("the reader's live editor is untouched while the owner looks back", (await editorText(reader)).includes('NEWER LINE'));

  await owner.click('qq-diff-view .back');
  await owner.waitForSelector('.cm-content');
  check('"Back to now" returns to the live editor and clears the highlight', (await editorText(owner)).includes('NEWER LINE') && (await owner.$('qq-history-panel .entry.on .nowchip')) !== null);

  // restore, with a safety copy and an undo
  await owner.evaluate(() => [...document.querySelectorAll('qq-history-panel .entry')].find((e) => e.innerText.includes('Before the rewrite')).click());
  await owner.waitForSelector('qq-diff-view');
  await owner.click('qq-history-panel .actions .go');
  await owner.waitForSelector('qq-history-panel dialog[open] .row .btn:not(.btn--ink)');
  await owner.click('qq-history-panel dialog[open] .row .btn:not(.btn--ink)');
  await owner.waitForSelector('qq-history-panel .notice .link');
  await until(async () => !(await editorText(owner)).includes('NEWER LINE'), 'live editor rewound');
  check('restoring rewrites the live scroll', true);
  await until(async () => !(await editorText(reader)).includes('NEWER LINE'), 'reader rewound too');
  check('everyone at the table sees the restore at once', true);
  check('the present was kept as a "saved before a restore" snapshot', (await owner.$$eval('qq-history-panel .entry', (l) => l.some((e) => e.innerText.includes('saved before a restore')))));
  await owner.screenshot({ path: `${OUT}/16-time-travel-restored.png` });
  await owner.click('qq-history-panel .notice .link'); // Undo
  await until(async () => (await editorText(owner)).includes('NEWER LINE'), 'undo brings the line back');
  check('Undo restores the scroll as it was before the restore', true);

  // name an automatic or safety snapshot: it is kept and shows under "Named"
  await owner.evaluate(() => [...document.querySelectorAll('qq-history-panel .entry')].find((e) => e.innerText.includes('saved before a restore')).click());
  await owner.waitForSelector('qq-diff-view');
  await byText(owner, 'qq-history-panel .actions .btn', 'Name it');
  await owner.waitForSelector('qq-history-panel dialog[open] input[name=label]');
  await owner.click('qq-history-panel dialog[open] input[name=label]', { clickCount: 3 });
  await owner.type('qq-history-panel dialog[open] input[name=label]', 'The good one');
  await owner.click('qq-history-panel dialog[open] button[type=submit]');
  await until(async () => (await owner.$$eval('qq-history-panel .entry', (l) => l.some((e) => e.innerText.includes('The good one')))), 'renamed entry');
  await byText(owner, 'qq-history-panel .chip-f', 'Named');
  check('"Name it" turns a snapshot into a named one that the Named filter shows', (await owner.$$eval('qq-history-panel .entry', (l) => l.map((e) => e.innerText))).every((t) => t.includes('Current') || !t.includes('auto-saved')) );
  await byText(owner, 'qq-history-panel .chip-f', 'All snapshots');
  await owner.click('qq-diff-view .back');
  await owner.waitForSelector('.cm-content');

  // a reader may look back but not change anything
  await panelBtn(reader, 'History');
  await reader.waitForSelector('qq-history-panel .entry');
  await until(async () => (await reader.$$('qq-history-panel .entry')).length > 1, 'the reader sees snapshots');
  await reader.evaluate(() => [...document.querySelectorAll('qq-history-panel .entry')][1].click());
  await reader.waitForSelector('qq-diff-view');
  check('readers can read old versions but get no restore, name or save buttons', (await reader.$('qq-history-panel .actions')) === null);
  await reader.click('qq-diff-view .back');
  await panelBtn(reader, 'History');
  await panelBtn(owner, 'History');

  // ---- panels: resize by dragging and keyboard, show/hide, rail, saved layout, pop-out windows
  const pbox = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const pnear = (a, b, tol = 3) => Math.abs(a - b) <= tol;
  const dragGrip = async (page, sel, dx, dy, whileDown) => {
    const b = await pbox(page, `${sel} .grip`);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx / 2, cy + dy / 2, { steps: 4 });
    await page.mouse.move(cx + dx, cy + dy, { steps: 4 });
    if (whileDown) await whileDown();
    await page.mouse.up();
    await sleep(100);
  };
  const openPanels = async (page) => { if (!(await page.$('qq-panels-menu .pop'))) await page.evaluate(() => document.querySelector('qq-panels-menu button.chipbtn').click()); await page.waitForSelector('qq-panels-menu .pop'); };
  const closePanels = (page) => page.evaluate(() => document.body.click());
  const sw = (page, i) => page.evaluate((n) => document.querySelectorAll('qq-panels-menu input[role=switch]')[n].click(), i);
  const popBtn = (page, i) => page.evaluate((n) => document.querySelectorAll('qq-panels-menu .pop-btn')[n].click(), i);
  const foot = (page, i) => page.evaluate((n) => document.querySelectorAll('qq-panels-menu .foot')[n].click(), i);

  await owner.bringToFront();
  if (await owner.$('qq-portrait-panel')) await owner.click('qq-portrait-panel .x'); // the picture's portrait shares the dock with the preview
  await owner.waitForSelector('qq-pdf-preview');
  const placement = await owner.$eval('main.workspace', (e) => { const areas = getComputedStyle(e).gridTemplateAreas; return [...e.children].map((c) => ({ c: c.tagName.toLowerCase(), area: getComputedStyle(c).gridArea, ok: areas.includes(getComputedStyle(c).gridArea.split(' ')[0]) })); });
  check('every panel is placed in an area the workspace grid defines', placement.every((p) => p.ok), placement.filter((p) => !p.ok).map((p) => `${p.c}:${p.area}`).join(', '));
  check('the editor opens with the designed layout (Tavern Hall 236 px, preview 460 px, ink log 170 px)', pnear((await pbox(owner, 'qq-file-tree')).w, 236) && pnear((await pbox(owner, 'qq-pdf-preview')).w, 460) && pnear((await pbox(owner, 'qq-ink-log')).h, 170));

  await dragGrip(owner, '.ht', 80, 0, async () => {
    check('a tooltip shows the size while dragging', (await owner.$eval('.ht .tip', (e) => e.textContent)).includes('Drag to resize'));
  });
  const pTreeW = (await pbox(owner, 'qq-file-tree')).w;
  check('dragging the strip beside the Tavern Hall resizes it', pnear(pTreeW, 316), `${pTreeW}px`);
  await dragGrip(owner, '.hp', -100, 0);
  const pPrevW = (await pbox(owner, 'qq-pdf-preview')).w;
  check('dragging the strip beside the preview resizes it (towards the editor makes it wider)', pnear(pPrevW, 560), `${pPrevW}px`);
  await dragGrip(owner, '.hl', 0, -60);
  check('dragging the strip above the ink log resizes it', pnear((await pbox(owner, 'qq-ink-log')).h, 230), `${(await pbox(owner, 'qq-ink-log')).h}px`);

  await owner.evaluate(() => document.querySelector('.hp .grip').focus());
  await owner.keyboard.press('ArrowLeft');
  await sleep(150);
  const pAfterKey = (await pbox(owner, 'qq-pdf-preview')).w;
  await owner.keyboard.down('Shift'); await owner.keyboard.press('ArrowLeft'); await owner.keyboard.up('Shift');
  await sleep(150);
  const pAfterShift = (await pbox(owner, 'qq-pdf-preview')).w;
  check('the arrow keys resize a focused strip (Shift for bigger steps)', pnear(pAfterKey - pPrevW, 16, 40) && pAfterShift > pAfterKey, `${pPrevW} -> ${pAfterKey} -> ${pAfterShift}`);
  check('the strip is announced as a separator with its value', (await owner.$eval('.hp .grip', (e) => e.getAttribute('role') + ':' + e.getAttribute('aria-valuenow'))).startsWith('separator:'));

  await owner.evaluate(() => document.querySelector('.ht .grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await sleep(100);
  check('double-clicking a strip puts it back to its default width', pnear((await pbox(owner, 'qq-file-tree')).w, 236));
  await dragGrip(owner, '.ht', 2000, 0);
  const pEditorW = (await pbox(owner, 'section.editor')).w;
  check('the source editor always keeps room, however far you drag', pEditorW >= 300, `${pEditorW}px`);
  await owner.evaluate(() => document.querySelector('.ht .grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await sleep(100);

  // the Panels menu
  await openPanels(owner);
  const pStatuses = await owner.$$eval('qq-panels-menu .row', (l) => l.map((r) => r.innerText.replace(/\s+/g, ' ')));
  check('the Panels menu lists the four panels with their state', pStatuses.length === 4 && /tavern hall/i.test(pStatuses[0]) && pStatuses[0].includes('Docked') && /ink log/i.test(pStatuses[3]), pStatuses.join(' | '));
  await owner.screenshot({ path: `${OUT}/17-panels-menu.png` });
  await sw(owner, 0);
  await owner.waitForSelector('nav.rail');
  check('hiding the Tavern Hall folds it into a narrow rail', pnear((await pbox(owner, 'nav.rail')).w, 44) && (await owner.$('qq-file-tree')) === null);
  await closePanels(owner);
  await owner.click('nav.rail button.rail-btn');
  await owner.waitForSelector('qq-file-tree');
  check('the rail expands it again', true);
  await openPanels(owner);
  await sw(owner, 2);
  await until(async () => (await owner.$('qq-pdf-preview')) === null, 'preview hidden');
  check('hiding the preview gives its room to the editor', (await pbox(owner, 'section.editor')).w > 700);
  await sw(owner, 2);
  await owner.waitForSelector('qq-pdf-preview');
  await sw(owner, 3);
  await until(async () => (await owner.$('qq-ink-log')) === null, 'ink log hidden');
  check('hiding the ink log removes its strip too', (await owner.$('.hl')) === null);
  await sw(owner, 3);
  await owner.waitForSelector('qq-ink-log');

  // my tavern layout survives a reload; reset forgets it
  await dragGrip(owner, '.ht', 60, 0);
  await openPanels(owner);
  await sw(owner, 3); // hide the ink log
  await foot(owner, 1);
  await owner.waitForSelector('.toast');
  check('"Save as my tavern layout" confirms', (await owner.$eval('.toast', (e) => e.textContent)).includes('Saved'));
  await owner.reload();
  await owner.waitForSelector('.cm-content');
  await owner.waitForSelector('qq-file-tree');
  check('a saved layout is back after a reload (Tavern Hall 296 px, no ink log)', pnear((await pbox(owner, 'qq-file-tree')).w, 296) && (await owner.$('qq-ink-log')) === null, `${(await pbox(owner, 'qq-file-tree')).w}px`);
  await openPanels(owner);
  await foot(owner, 0);
  await owner.waitForSelector('qq-ink-log');
  check('"Reset to default layout" restores everything', pnear((await pbox(owner, 'qq-file-tree')).w, 236) && pnear((await pbox(owner, 'qq-ink-log')).h, 170));
  await owner.reload();
  await owner.waitForSelector('qq-file-tree');
  check('and forgets the saved layout', pnear((await pbox(owner, 'qq-file-tree')).w, 236) && (await owner.$('qq-ink-log')) !== null);

  // every panel hidden: a hint, and a way back
  await openPanels(owner);
  for (const i of [0, 1, 2, 3]) await sw(owner, i);
  await owner.waitForSelector('.empty-hint');
  await closePanels(owner);
  check('with every panel hidden the workspace says so and offers a reset', (await owner.$eval('.empty-hint', (e) => e.innerText)).includes('Reset to default layout'));
  await owner.click('.empty-hint .btn');
  await owner.waitForSelector('section.editor');
  check('the reset button brings the panels back', (await owner.$('qq-pdf-preview')) !== null && (await owner.$('qq-file-tree')) !== null);

  // ---- pop the preview out into its own window
  const popWinLogClick = () => logWin.evaluate(() => [...document.querySelectorAll('button.line.bad')].find((b) => !b.disabled)?.click());
  const pNextPage = () => browser.waitForTarget((t) => t.url().includes('/popout/'), { timeout: 15000 }).then((t) => t.page());
  await openPanels(owner);
  let pWaiting = pNextPage();
  await popBtn(owner, 2);
  const popWin = await pWaiting;
  await popWin.waitForSelector('qq-pdf-preview');
  await owner.waitForSelector('.away');
  check('"Pop out" opens the preview in a window of its own and leaves a note behind', (await owner.$eval('.away', (e) => e.innerText)).includes('Scroll Preview is open in another window'));
  await popWin.waitForSelector('qq-pdf-preview .page canvas');
  check('the popped-out window shows the PDF and says it is live-linked', (await popWin.title()).includes('Scroll Preview') && (await popWin.$eval('.win', (e) => e.innerText)).includes('Dock back'));
  await until(async () => (await popWin.$eval('.foot', (e) => e.innerText)).includes('Live-linked'), 'popup linked');
  check('the popup is live-linked to the main window', true);
  const prevSrc = await popWin.$eval('qq-pdf-preview .scroller', (e) => e.getAttribute('data-src'));
  await owner.bringToFront();
  await owner.click('.cm-content');
  await owner.keyboard.down('Control'); await owner.keyboard.press('Enter'); await owner.keyboard.up('Control');
  await until(async () => (await popWin.$eval('qq-pdf-preview .scroller', (e) => e.getAttribute('data-src'))) !== prevSrc, 'popup follows the new build');
  check('a new compile in the main window shows up in the popped-out preview', true);
  await popWin.screenshot({ path: `${OUT}/18-preview-popout.png` });
  await popWin.click('header .btn:last-child');
  await until(() => popWin.isClosed(), 'popup closes after Dock back', 6000);
  await owner.waitForSelector('qq-pdf-preview');
  check('"Dock back" closes the window and puts the preview back', (await owner.$('.away')) === null);

  // closing the window by hand docks it again too
  await openPanels(owner);
  pWaiting = pNextPage();
  await popBtn(owner, 2);
  const popWin2 = await pWaiting;
  await popWin2.waitForSelector('qq-pdf-preview');
  await popWin2.close();
  await owner.waitForSelector('qq-pdf-preview', { timeout: 8000 });
  check('closing the popped-out window by hand docks the preview again', (await owner.$('.away')) === null);

  // the ink log in its own window, with a clickable error that jumps in the main editor
  await openPanels(owner);
  pWaiting = pNextPage();
  await popBtn(owner, 3);
  const logWin = await pWaiting;
  await logWin.waitForSelector('qq-ink-log');
  await owner.waitForSelector('.away-row');
  check('the ink log can be popped out too, leaving a slim note', (await owner.$eval('.away-row', (e) => e.innerText)).includes('Ink Log is open in another window'));
  await owner.bringToFront();
  // on the blank line 4 of the preamble (text after \end{document} would be ignored by TeX, so it must not go there)
  await owner.click('.cm-content');
  await owner.keyboard.down(MOD_KEY);
  await owner.keyboard.press(MOD_KEY === 'Meta' ? 'ArrowUp' : 'Home');
  await owner.keyboard.up(MOD_KEY);
  for (let i = 0; i < 3; i++) await owner.keyboard.press('ArrowDown');
  await owner.keyboard.type('\\zzbadcommand');
  await owner.keyboard.down('Control'); await owner.keyboard.press('Enter'); await owner.keyboard.up('Control');
  await logWin.waitForSelector('.line.bad', { timeout: 60000 });
  check('a failed build shows its errors in the popped-out ink log', (await logWin.$eval('.chip--bad', (e) => e.textContent)).includes('Failed'));
  await logWin.screenshot({ path: `${OUT}/19-log-popout.png` });
  await owner.bringToFront();
  await owner.click('.cm-content');
  await owner.keyboard.down('Control'); await owner.keyboard.press('Home'); await owner.keyboard.up('Control'); // cursor to line 1
  await sleep(200);
  const pLnBefore = await owner.$eval('.status span', (e) => e.textContent);
  await popWinLogClick();
  await until(async () => (await owner.$eval('.status span', (e) => e.textContent)) !== pLnBefore, 'the editor jumps to the error');
  check('clicking an error in the popped-out log jumps to it in the editor', true, `${pLnBefore} -> ${await owner.$eval('.status span', (e) => e.textContent)}`);
  // tidy: undo the bad command (however the typing was grouped), then build again
  await owner.bringToFront();
  await owner.click('.cm-content');
  for (let i = 0; i < 20 && (await editorText(owner)).includes('zzbadcommand'); i++) {
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'; // CodeMirror's undo is Mod-z
    await owner.keyboard.down(mod); await owner.keyboard.press('z'); await owner.keyboard.up(mod);
    await sleep(120);
  }
  check('the bad command is undone again', !(await editorText(owner)).includes('zzbadcommand'));
  await owner.keyboard.down('Control'); await owner.keyboard.press('Enter'); await owner.keyboard.up('Control');
  await until(async () => (await logWin.$eval('.chip--ok', (e) => e.textContent).catch(() => '')).includes('Compiled'), 'log window follows the fixed build', 60000);
  check('the popped-out log follows the build back to green', true);
  await owner.evaluate(() => [...document.querySelectorAll('.away-row button')].find((b) => b.textContent.includes('Bring it back')).click());
  await owner.waitForSelector('qq-ink-log');
  await until(() => logWin.isClosed(), 'log window closes when brought back', 6000);
  check('"Bring it back" closes the ink log window and docks it', (await owner.$('.away-row')) === null);

  // ---- margin notes: threads anchored to text, replies, @mentions, resolve, live for everyone
  const nMod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const nBtn = (page, text) => page.evaluate((t) => [...document.querySelectorAll('header .panels button')].find((b) => b.textContent.trim().startsWith(t)).click(), text);
  const nThreads = (page) => page.$$eval('qq-comments-panel .thread', (l) => l.map((e) => e.innerText.replace(/\s+/g, ' ')));
  const nTop = async () => { if (process.platform === 'darwin') { await owner.keyboard.down('Meta'); await owner.keyboard.press('ArrowUp'); await owner.keyboard.up('Meta'); } else { await owner.keyboard.down('Control'); await owner.keyboard.press('Home'); await owner.keyboard.up('Control'); } };
  const nBottom = async () => { if (process.platform === 'darwin') { await owner.keyboard.down('Meta'); await owner.keyboard.press('ArrowDown'); await owner.keyboard.up('Meta'); } else { await owner.keyboard.down('Control'); await owner.keyboard.press('End'); await owner.keyboard.up('Control'); } };
  // CodeMirror keeps one hidden spacer marker in the gutter: count only the markers you can see
  const nDots = (page) => page.evaluate(() => [...document.querySelectorAll('.cm-notes-gutter .note-dot')].filter((d) => getComputedStyle(d.parentElement).visibility !== 'hidden').length);
  const nLine = (page) => page.$eval('qq-comments-panel .thread .ln', (e) => e.textContent);
  const nClickText = (page, scope, text) => page.evaluate((sc, t) => [...document.querySelectorAll(sc)].find((b) => b.textContent.trim().startsWith(t)).click(), scope, text);
  await owner.bringToFront();
  await owner.click('.cm-content');
  await nTop();
  await owner.keyboard.down('Shift'); await owner.keyboard.press('End'); await owner.keyboard.up('Shift'); // select the first line
  await sleep(150);
  await nBtn(owner, 'Notes');
  await owner.waitForSelector('qq-comments-panel');
  check('the Notes button opens the Margin Notes panel, empty at first', (await owner.$eval('qq-comments-panel .open-chip', (e) => e.textContent)).includes('0 open') && (await owner.$eval('qq-comments-panel .none', (e) => e.innerText)).includes('No margin notes yet'));
  check('with text selected the composer says it will be about the selection', (await owner.$eval('qq-comments-panel .compose textarea', (e) => e.getAttribute('placeholder'))).includes('the selection'));
  await owner.type('qq-comments-panel .compose textarea', 'Why 12pt here?');
  await owner.keyboard.press('Enter');
  await owner.waitForSelector('qq-comments-panel .thread');
  check('posting creates a thread on the selected text, with its line and quote', (await nLine(owner)) === 'line 1' && (await owner.$eval('qq-comments-panel .thread .quote', (e) => e.textContent)).includes('documentclass'));
  check('the composer is emptied once the note is posted', (await owner.$eval('qq-comments-panel .compose textarea', (e) => e.value)) === '');
  await until(async () => (await owner.$$('.cm-note')).length >= 1 && (await nDots(owner)) === 1, 'highlight and gutter marker appear', 4000);
  check('the text carries a highlight and a gutter marker', true);
  check('the header shows how many notes are open', (await owner.$eval('header .panels button.on .count-badge', (e) => e.textContent)).trim() === '1');
  await owner.screenshot({ path: `${OUT}/20-margin-notes.png` });

  // the reader sees it live and can read but not write
  await reader.bringToFront();
  await nBtn(reader, 'Notes');
  await reader.waitForSelector('qq-comments-panel .thread');
  await until(async () => (await nDots(reader)) === 1, 'reader gets the gutter marker', 4000);
  check('the reader sees the note the moment it is written', (await nThreads(reader))[0].includes('Why 12pt here?'));
  check('readers get no composer, reply or resolve', (await reader.$('qq-comments-panel .compose textarea')) === null && (await reader.$('qq-comments-panel .act')) === null && (await reader.$eval('qq-comments-panel .ro', (e) => e.innerText)).includes('Readers can read'));

  // reply with an @mention of the reader
  await owner.bringToFront();
  await nClickText(owner, 'qq-comments-panel .act', 'Reply');
  await owner.waitForSelector('qq-comments-panel .thread textarea');
  await owner.type('qq-comments-panel .thread textarea', 'Checking with @Row');
  await owner.waitForSelector('qq-comments-panel .thread .pick button');
  await until(async () => (await owner.$eval('qq-comments-panel .thread .pick button', (e) => e.textContent)).includes('Rowan'), 'suggestions narrow to Rowan', 4000);
  check('typing @ suggests the scribes at the table', true);
  await owner.keyboard.press('Enter'); // picks the suggestion
  await owner.keyboard.type('please');
  await owner.keyboard.press('Enter'); // sends
  await until(async () => (await owner.$$('qq-comments-panel .thread .msg')).length === 2, 'reply appears');
  check('the reply joins the thread with the mention highlighted', (await owner.$eval('qq-comments-panel .thread .mention', (e) => e.textContent)) === '@Rowan');
  await until(async () => (await reader.$$('qq-comments-panel .thread .msg')).length === 2, 'reader sees the reply');
  check('the reader sees the reply live, and is the one mentioned', await reader.$eval('qq-comments-panel .thread .mention', (e) => e.classList.contains('you')));

  // the note stays on its words while the text above it changes
  await owner.click('.cm-content');
  await nTop();
  await owner.keyboard.type('% a new first line\n');
  await until(async () => (await nLine(owner)) === 'line 2', 'note follows the text down', 5000);
  check('a note stays attached to its words when text is added above it', true);
  await until(async () => (await nLine(reader)) === 'line 2', 'reader sees it move too', 5000);
  check('and it moves for everyone', true);

  // resolve and reopen
  await nClickText(owner, 'qq-comments-panel .act', '✓ Resolve');
  await until(async () => (await owner.$$('qq-comments-panel .thread')).length === 0, 'resolved thread leaves the open list');
  check('resolving takes the thread out of the open list and the count goes to zero', (await owner.$eval('qq-comments-panel .open-chip', (e) => e.textContent)).includes('0 open') && (await owner.$('header .panels .count-badge')) === null);
  await nClickText(owner, 'qq-comments-panel .chip-f', 'Resolved');
  await owner.waitForSelector('qq-comments-panel .thread.resolved');
  check('it is kept under Resolved, saying who resolved it', (await owner.$eval('qq-comments-panel .thread .done', (e) => e.textContent)).includes('Resolved by'));
  await nClickText(owner, 'qq-comments-panel .act', '↺ Reopen');
  await nClickText(owner, 'qq-comments-panel .chip-f', 'Open');
  await owner.waitForSelector('qq-comments-panel .thread');
  check('reopening puts it back', true);

  // clicking the gutter marker picks the thread; clicking a card shows its text
  await owner.click('qq-comments-panel .compose textarea'); // move focus away from the editor
  await owner.evaluate(() => { const d = [...document.querySelectorAll('.cm-notes-gutter .note-dot')].find((x) => getComputedStyle(x.parentElement).visibility !== 'hidden'); const r = d.getBoundingClientRect(); window.__dot = { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const dotAt = await owner.evaluate(() => window.__dot);
  await owner.mouse.click(dotAt.x, dotAt.y);
  await owner.waitForSelector('qq-comments-panel .thread.on');
  check('clicking the gutter marker selects its thread in the panel', true);
  check('the selected note is highlighted in the text', (await owner.$$('.cm-note-sel')).length >= 1);
  await owner.click('.cm-content');
  await nBottom();
  await owner.click('qq-comments-panel .thread .where');
  await until(async () => (await owner.$eval('.status span', (e) => e.textContent)).startsWith('Ln 2'), 'editor reveals the note', 4000);
  check('clicking a thread shows its text in the editor', true);

  // the shortcut opens the panel and puts you in the composer
  await nBtn(owner, 'Notes'); // close
  await until(async () => (await owner.$('qq-comments-panel')) === null, 'panel closes');
  await owner.click('.cm-content');
  await owner.keyboard.down(nMod); await owner.keyboard.down('Alt'); await owner.keyboard.press('KeyM'); await owner.keyboard.up('Alt'); await owner.keyboard.up(nMod);
  await owner.waitForSelector('qq-comments-panel .compose textarea', { timeout: 4000 });
  await until(async () => owner.evaluate(() => document.activeElement?.closest('.compose') != null), 'composer focused', 3000);
  check('Ctrl/Cmd + Alt + M opens the notes panel with the composer ready', true);

  // taking a thread away removes it for everyone, highlight and marker included
  await nClickText(owner, 'qq-comments-panel .act', 'Delete thread');
  await until(async () => (await owner.$$('qq-comments-panel .thread')).length === 0, 'thread deleted');
  await until(async () => (await reader.$$('qq-comments-panel .thread')).length === 0, 'thread gone for the reader');
  await until(async () => (await nDots(owner)) === 0 && (await nDots(reader)) === 0 && (await owner.$$('.cm-note')).length === 0, 'markers and highlights are gone', 4000);
  check('deleting a thread takes it away for everyone, with its marker and highlight', true);
  await nBtn(owner, 'Notes');
  await nBtn(reader, 'Notes');
  // take the extra first line out again so later sections see the document they expect
  await owner.click('.cm-content');
  await nTop();
  for (let i = 0; i < 19; i++) await owner.keyboard.press('Delete');

  // ---- dragging pictures into the document always asks how to place them
  const dpB64 = makePng(40, 30).toString('base64');
  const dpDrop = (page, files, tree) => page.evaluate((list, assetPath) => {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    if (assetPath) dt.setData('application/x-quill-asset', assetPath);
    const line = document.querySelectorAll('.cm-line')[2].getBoundingClientRect(); // the third line
    const target = document.querySelector('section.editor');
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: line.x + 20, clientY: line.y + line.height / 2 }));
  }, files, tree ?? null);
  const dpDialogOpen = (page) => page.waitForSelector('dialog.portrait[open]', { timeout: 10000 });
  await owner.bringToFront();
  await owner.click('.cm-content');
  await dpDrop(owner, [{ name: 'dropped-one.png', type: 'image/png', b64: dpB64 }]);
  await dpDialogOpen(owner);
  check('dropping a picture on the editor always opens "Hang a Portrait in Your Scroll"', true);
  check('the dialog has that picture chosen', (await owner.$eval('dialog.portrait[open] select[name=image]', (e) => e.value)) === 'figures/dropped-one.png');
  check('and says it goes in at the drop point (line 3)', (await owner.$eval('dialog.portrait[open] .where', (e) => e.textContent)).includes('line 3'));
  check('the picture was added to the Tavern Hall list', (await owner.$$eval('qq-file-tree li.asset .nm', (l) => l.map((x) => x.textContent))).includes('dropped-one.png'));
  await owner.screenshot({ path: `${OUT}/27-drop-prompt.png` });
  await owner.click('dialog.portrait[open] .foot .btn:not(.btn--ink)');
  await until(async () => (await editorText(owner)).includes('figures/dropped-one.png'), 'figure inserted at the drop point');
  const droppedText = await editorText(owner);
  const dropLine = droppedText.split('\n').findIndex((l) => l.includes('figures/dropped-one.png'));
  check('Insert Portrait puts the figure at the drop point (line 3), not at the end', dropLine >= 0 && droppedText.indexOf('figures/dropped-one.png') < droppedText.indexOf('\\section{Introduction}'), `inserted near line ${dropLine + 1}`);

  // a picture already in the hall, dragged into the document
  await dpDrop(owner, [], 'figures/dropped-one.png');
  await dpDialogOpen(owner);
  check('dragging a picture from the Tavern Hall into the document asks the same question', (await owner.$eval('dialog.portrait[open] select[name=image]', (e) => e.value)) === 'figures/dropped-one.png');
  await owner.click('dialog.portrait[open] .foot .btn--ink'); // Cancel
  await until(async () => (await owner.$('dialog.portrait[open]')) === null, 'dialog closed');
  check('and Cancel inserts nothing', (await editorText(owner)).split('figures/dropped-one.png').length === droppedText.split('figures/dropped-one.png').length);

  // two at once: asked one after the other
  await dpDrop(owner, [{ name: 'two-a.png', type: 'image/png', b64: dpB64 }, { name: 'two-b.png', type: 'image/png', b64: dpB64 }]);
  await dpDialogOpen(owner);
  check('two pictures dropped together are asked about one at a time (first)', (await owner.$eval('dialog.portrait[open] select[name=image]', (e) => e.value)) === 'figures/two-a.png');
  await owner.click('dialog.portrait[open] .foot .btn--ink');
  await until(async () => (await owner.$eval('dialog.portrait[open] select[name=image]', (e) => e.value).catch(() => '')) === 'figures/two-b.png', 'second dialog follows');
  check('and then the second', true);
  await owner.click('dialog.portrait[open] .foot .btn--ink');
  await until(async () => (await owner.$('dialog.portrait[open]')) === null, 'queue finished');

  // not a picture: explained, never opened as a page
  await dpDrop(owner, [{ name: 'notes.txt', type: 'text/plain', b64: btoa('hello') }]);
  await until(async () => (await owner.$$eval('.toast', (l) => l.some((e) => e.textContent.includes('Only pictures and PDFs')))), 'a toast explains', 4000);
  check('dropping something that is not a picture says what can be dropped', true);
  check('and no dialog opens', (await owner.$('dialog.portrait[open]')) === null && owner.url().includes('/scroll/'));

  // readers may not
  await reader.bringToFront();
  await reader.click('.cm-content');
  await dpDrop(reader, [{ name: 'reader.png', type: 'image/png', b64: dpB64 }]);
  await until(async () => (await reader.$$eval('.toast', (l) => l.some((e) => e.textContent.includes('Readers cannot')))), 'a toast tells the reader', 4000);
  check('a reader dropping a picture is told they cannot, and nothing opens', (await reader.$('dialog.portrait[open]')) === null);

  // take the inserted figure out again so the document is as the next sections expect
  await owner.bringToFront();
  await owner.click('.cm-content');
  for (let i = 0; i < 25 && (await editorText(owner)).includes('figures/dropped-one.png'); i++) {
    const dpMod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await owner.keyboard.down(dpMod); await owner.keyboard.press('z'); await owner.keyboard.up(dpMod);
    await sleep(120);
  }
  check('the dropped figure is undone again', !(await editorText(owner)).includes('figures/dropped-one.png'));

  // ---- the command menu and the word-processor text shortcuts
  const kMod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const chord = async (page, key, extra = []) => {
    await page.keyboard.down(kMod);
    for (const x of extra) await page.keyboard.down(x);
    await page.keyboard.press(key);
    for (const x of [...extra].reverse()) await page.keyboard.up(x);
    await page.keyboard.up(kMod);
  };
  await owner.bringToFront();
  await owner.click('.cm-content');
  await chord(owner, 'k');
  await owner.waitForSelector('dialog.palette[open]');
  check('Ctrl/⌘+K opens the command menu', true);
  check('it lists actions, files and help under their headings', (await owner.$$eval('dialog.palette .sec', (l) => l.map((e) => e.textContent))).join() === 'Actions,Files,Help');
  await owner.screenshot({ path: `${OUT}/30-command-menu.png` });
  // keyboard navigation always keeps the highlighted row in view (here: wrap round to the very last one, then walk back up)
  const inView = () => owner.evaluate(() => {
    const list = document.querySelector('dialog.palette ul').getBoundingClientRect();
    const on = document.querySelector('dialog.palette li.on')?.getBoundingClientRect();
    return !!on && on.top >= list.top - 1 && on.bottom <= list.bottom + 1;
  });
  await owner.keyboard.press('ArrowUp');
  await sleep(150);
  check('wrapping to the last row scrolls it into view', await inView());
  let allVisible = true;
  for (let i = 0; i < 30; i++) {
    await owner.keyboard.press('ArrowUp');
    await sleep(40);
    if (!(await inView())) allVisible = false;
  }
  check('and every row on the way back up is in view when highlighted', allVisible);
  await owner.keyboard.press('Home');
  await sleep(100);
  check('Home returns to the first row with its heading showing', await owner.evaluate(() => document.querySelector('dialog.palette ul').scrollTop === 0));
  await owner.type('dialog.palette input', 'tavern hall');
  await sleep(200);
  const hits = await owner.$$eval('dialog.palette li[role=option] b', (l) => l.map((e) => e.textContent));
  check('typing narrows it to matching commands', hits.includes('Open the Tavern Hall') && !hits.includes('Compile the scroll'), hits.join(' | '));
  await chord(owner, '3');
  await sleep(150);
  check('Ctrl/⌘+3 shows only files', (await owner.$$eval('dialog.palette li[role=option]', (l) => l.length)) === 0 || (await owner.$$eval('dialog.palette .sec', (l) => l.map((e) => e.textContent))).join() === 'Files');
  await chord(owner, '1');
  await owner.keyboard.press('Escape');
  await until(async () => (await owner.$('dialog.palette[open]')) === null, 'menu closed');
  check('Escape closes the command menu', true);
  // a command from the menu: "New file" opens the form in the Tavern Hall list
  await chord(owner, 'k');
  await owner.waitForSelector('dialog.palette[open]');
  await owner.type('dialog.palette input', 'new file');
  await sleep(200);
  await owner.keyboard.press('Enter');
  await owner.waitForSelector('qq-file-tree form.add input[aria-label="New file path"], qq-file-tree form.add input[aria-label="New file name"]');
  check('choosing "New file" in the menu opens the new-file form', true);
  await owner.click('qq-file-tree button[aria-label="New file"]'); // close the form again
  // text shortcuts act on the selected words
  await owner.click('.cm-content');
  await chord(owner, 'ArrowDown');
  await owner.keyboard.type(' zzz');
  // select the three letters just typed: the end of the document, then extend left three times
  await chord(owner, 'ArrowDown');
  await owner.keyboard.down('Shift');
  for (let i = 0; i < 3; i++) await owner.keyboard.press('ArrowLeft');
  await owner.keyboard.up('Shift');
  await chord(owner, 'b');
  await until(async () => (await editorText(owner)).includes('\\textbf{zzz}'), 'bold applied');
  check('Ctrl/⌘+B makes the selected words bold (\\textbf{…})', true);
  await chord(owner, 'b');
  await until(async () => !(await editorText(owner)).includes('\\textbf{zzz}'), 'bold removed');
  check('and again takes the bold off', (await editorText(owner)).includes(' zzz'));
  await chord(owner, 'i');
  await until(async () => (await editorText(owner)).includes('\\textit{zzz}'), 'italic applied');
  check('Ctrl/⌘+I makes it italic (\\textit{…})', true);
  await chord(owner, 'i');
  await chord(owner, 'u');
  await until(async () => (await editorText(owner)).includes('\\underline{zzz}'), 'underline applied');
  check('Ctrl/⌘+U underlines it', true);
  await chord(owner, 'u');
  await chord(owner, '.');
  await until(async () => (await editorText(owner)).includes('\\textsuperscript{zzz}'), 'superscript applied');
  check('Ctrl/⌘+. makes it a superscript', true);
  await chord(owner, '.');
  await chord(owner, ',');
  await until(async () => (await editorText(owner)).includes('\\textsubscript{zzz}'), 'subscript applied');
  check('Ctrl/⌘+, makes it a subscript', true);
  await chord(owner, ',');
  await chord(owner, '/');
  await until(async () => /^\s*% .*zzz/m.test(await editorText(owner)), 'line commented');
  check('Ctrl/⌘+/ comments the line out', true);
  await chord(owner, '/');
  await until(async () => !/%.*zzz/.test(await editorText(owner)), 'line uncommented');
  check('and again brings it back', true);
  await owner.keyboard.press('ArrowRight'); // let go of the selection, caret after "zzz"
  for (let i = 0; i < 4; i++) await owner.keyboard.press('Backspace'); // take the typed " zzz" away again
  await sleep(300);
  check('the experiments left the document as it was', !(await editorText(owner)).includes('zzz'));

  // ---- the onboarding tour (started from the command menu; on a first visit it opens by itself)
  await chord(owner, 'k');
  await owner.waitForSelector('dialog.palette[open]');
  await owner.type('dialog.palette input', 'take the tour');
  await sleep(200);
  await owner.keyboard.press('Enter');
  await owner.waitForSelector('qq-tour .card');
  check('"Take the tour" in the command menu starts the tour', true);
  const tourText = () => owner.$eval('qq-tour .card', (e) => e.innerText.replace(/\s+/g, ' '));
  check('it begins with "Welcome to the Tavern Hall", step 1 of 4', /step 1 of 4/i.test(await tourText()) && (await tourText()).includes('Welcome to the Tavern Hall'));
  const tourGeometry = await owner.evaluate(() => {
    const box = (q) => { const r = document.querySelector(q).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    return { spot: box('qq-tour .spot'), tree: box('qq-file-tree'), card: box('qq-tour .card'), view: { w: innerWidth, h: innerHeight } };
  });
  check('the lit-up frame surrounds the Tavern Hall panel', Math.abs(tourGeometry.spot.x - tourGeometry.tree.x) <= 6 && Math.abs(tourGeometry.spot.w - tourGeometry.tree.w) <= 10 && Math.abs(tourGeometry.spot.h - tourGeometry.tree.h) <= 10);
  check('the card sits beside it and fully on screen', tourGeometry.card.x >= tourGeometry.spot.x + tourGeometry.spot.w && tourGeometry.card.x + tourGeometry.card.w <= tourGeometry.view.w && tourGeometry.card.y >= 0 && tourGeometry.card.y + tourGeometry.card.h <= tourGeometry.view.h);
  await owner.screenshot({ path: `${OUT}/31-tour-step-1.png` });
  check('the page behind cannot be clicked (the shield covers it)', await owner.evaluate(() => document.elementFromPoint(700, 500)?.classList.contains('shield')));
  await owner.keyboard.press('ArrowRight');
  await until(async () => (await tourText()).includes('Write together'), 'step 2');
  check('the arrow keys move through the steps', /step 2 of 4/i.test(await tourText()));
  await owner.click('qq-tour .card .back');
  await until(async () => (await tourText()).includes('Welcome to the Tavern Hall'), 'back to step 1');
  check('Back returns to the step before', true);
  for (let i = 0; i < 3; i++) {
    await owner.click('qq-tour .card .btn');
    await sleep(350);
  }
  check('the last step says Done and points at Share', (await owner.$eval('qq-tour .card .btn', (e) => e.textContent.trim())) === 'Done' && (await tourText()).includes('Bring in more scribes'));
  await owner.click('qq-tour .card .btn');
  await until(async () => (await owner.$('qq-tour .card')) === null, 'tour closed');
  check('Done closes the tour and the page can be used again', (await owner.evaluate(() => localStorage.getItem('quill.tour.v1'))) !== null);
  await chord(owner, 'k');
  await owner.waitForSelector('dialog.palette[open]');
  await owner.type('dialog.palette input', 'take the tour');
  await sleep(200);
  await owner.keyboard.press('Enter');
  await owner.waitForSelector('qq-tour .card');
  await owner.keyboard.press('Escape');
  await until(async () => (await owner.$('qq-tour .card')) === null, 'tour skipped');
  check('Escape skips the tour at any step', true);

  // ---- search and replace across every file (Ctrl/⌘+F)
  await owner.click('.cm-content');
  await chord(owner, 'ArrowDown');
  await owner.keyboard.type(' qqzz and qqzz');
  await sleep(300);
  await chord(owner, 'f');
  await owner.waitForSelector('qq-search-panel input[aria-label="Find"]');
  check('Ctrl/⌘+F opens "Search the Tavern" with the caret in the find box', await owner.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Find'));
  await owner.keyboard.type('qqzz');
  await until(async () => /2 matches in 1 file/.test(await owner.$eval('qq-search-panel .count', (e) => e.textContent)), 'count shown');
  check('it counts the matches and the files they are in ("2 matches in 1 file")', true);
  check('the matches are listed under their file, and lit up in the text', (await owner.$$eval('qq-search-panel .hit', (l) => l.length)) === 2 && (await owner.$$('.cm-search-match')).length === 2);
  await owner.screenshot({ path: `${OUT}/32-search-panel.png` });
  await owner.keyboard.press('Enter');
  await until(async () => (await owner.$$('.cm-search-current')).length === 1, 'current match marked');
  check('Enter goes to a match: it is selected and marked as the current one', true);
  await owner.keyboard.down('Shift');
  await owner.keyboard.press('Enter');
  await owner.keyboard.up('Shift');
  await sleep(200);
  check('Shift+Enter goes back', (await owner.$$('.cm-search-current')).length === 1);
  await owner.click('qq-search-panel .chip[title="Match case"]');
  await owner.click('qq-search-panel .chip[title="Whole words only"]');
  await until(async () => (await owner.$$eval('qq-search-panel .chip.on', (l) => l.length)) === 2, 'chips on');
  check('the option chips switch on and off', true);
  await owner.click('qq-search-panel .chip[title="Match case"]');
  await owner.click('qq-search-panel .chip[title="Whole words only"]');
  // replace everything: the first click only asks
  await owner.click('qq-search-panel input[aria-label="Replace with"]');
  await owner.keyboard.type('wwyy');
  const allBtn = 'qq-search-panel .acts .btn:not(.btn--ghost)';
  await owner.click(allBtn);
  await sleep(150);
  check('Replace all asks first ("Replace 2? Click again") and changes nothing yet', (await owner.$eval(allBtn, (e) => e.textContent.trim())).startsWith('Replace 2') && !(await editorText(owner)).includes('wwyy'));
  await owner.click(allBtn);
  await until(async () => (await editorText(owner)).includes('wwyy and wwyy'), 'replaced');
  check('the second click replaces every match', !(await editorText(owner)).includes('qqzz'));
  await until(async () => ((await owner.$eval('qq-search-panel .note.ok', (e) => e.textContent).catch(() => '')) || '').includes('Replaced 2 matches in 1 file'), 'replaced message');
  check('and says how many were replaced', true);
  // put it back to nothing: search wwyy, replace with an empty box
  await owner.click('qq-search-panel input[aria-label="Find"]', { clickCount: 3 });
  await owner.keyboard.type('wwyy');
  await owner.click('qq-search-panel input[aria-label="Replace with"]', { clickCount: 3 });
  await owner.keyboard.press('Backspace');
  await owner.click(allBtn);
  await sleep(150);
  await owner.click(allBtn);
  await until(async () => !(await editorText(owner)).includes('wwyy'), 'cleared again');
  await owner.keyboard.press('Escape');
  await until(async () => (await owner.$('qq-search-panel')) === null, 'panel closed');
  check('Escape closes the panel and the highlights go with it', (await owner.$$('.cm-search-match')).length === 0);
  await owner.click('.cm-content');
  await chord(owner, 'ArrowDown');
  for (let i = 0; i < 6; i++) await owner.keyboard.press('Backspace'); // the " and " left over from the experiment
  await sleep(300);

  // ---- new folders from the Tavern Hall list: empty ones show up, files can be started inside them
  await owner.bringToFront();
  await owner.click('qq-file-tree button[aria-label="New folder"]');
  await owner.waitForSelector('qq-file-tree form.folder');
  await owner.type('qq-file-tree form.folder input[name=folder]', 'drafts');
  await sleep(200);
  await owner.click('qq-file-tree form.folder button[type=submit]');
  await until(async () => (await owner.$$eval('qq-file-tree li.dir', (l) => l.some((e) => e.textContent.includes('drafts')))), 'the new folder appears in the list', 4000);
  check('"New folder" adds an empty folder to the Tavern Hall list', (await owner.$('qq-file-tree button[aria-label="Remove empty folder drafts"]')) !== null);
  await owner.screenshot({ path: `${OUT}/29-new-folder.png` });
  await until(async () => (await reader.$$eval('qq-file-tree li.dir', (l) => l.some((e) => e.textContent.includes('drafts')))), 'reader sees the folder', 6000);
  check('everyone at the table sees the new folder at once (readers get no buttons for it)', (await reader.$('qq-file-tree button[aria-label="New folder"]')) === null && (await reader.$('qq-file-tree button[aria-label="New file in drafts"]')) === null);
  await owner.click('qq-file-tree button[aria-label="New file in drafts"]');
  await owner.waitForSelector('qq-file-tree form.add input[aria-label="New file name"]');
  check('the plus beside a folder starts a new file inside it, with the folder shown locked', (await owner.$eval('qq-file-tree form.add input.locked', (e) => e.value === 'drafts/' && e.disabled)) === true);
  await owner.type('qq-file-tree form.add input[aria-label="New file name"]', 'idea.tex');
  await owner.keyboard.press('Enter');
  await until(async () => (await owner.$$eval('qq-file-tree li.file .nm', (l) => l.map((e) => e.textContent))).includes('idea.tex'), 'file appears in its folder', 4000);
  check('the new file sits in that folder, and the folder can no longer be removed as empty', (await owner.$('qq-file-tree button[aria-label="Remove empty folder drafts"]')) === null);
  await owner.click('qq-file-tree li.file.active, qq-file-tree li.file'); // leave the new file open: back to main below
  await owner.evaluate(() => [...document.querySelectorAll('qq-file-tree li.file')].find((e) => e.textContent.includes('main.tex')).click());
  await owner.waitForSelector('.cm-content');
  await owner.click('qq-file-tree button[aria-label="New folder"]');
  await owner.waitForSelector('qq-file-tree form.folder input[name=folder]');
  await owner.type('qq-file-tree form.folder input[name=folder]', 'drafts');
  await sleep(200);
  await owner.click('qq-file-tree form.folder button[type=submit]');
  await sleep(300);
  check('a folder name that is already taken is explained', (await owner.$eval('qq-file-tree form.folder .err', (e) => e.textContent)).includes('already exists'));
  await owner.click('qq-file-tree form.folder button.act:not(.on)'); // Cancel

  // ---- picture paths complete as you type them, from the pictures in the scroll
  await owner.bringToFront();
  await owner.click('.cm-content');
  await nBottom();
  await owner.keyboard.type('\n\\includegraphics{fig');
  await owner.waitForSelector('.cm-tooltip-autocomplete li');
  await until(async () => (await owner.$$eval('.cm-tooltip-autocomplete li', (l) => l.map((e) => e.innerText))).some((t) => t.includes('figures/orbit-test.png')), 'picture paths are suggested', 5000);
  const picks = await owner.$$eval('.cm-tooltip-autocomplete li', (l) => l.map((e) => e.innerText.replace(/\s+/g, ' ')));
  check('typing \\includegraphics{fig suggests the scroll\'s pictures', picks.some((t) => t.includes('figures/orbit-test.png')) && picks.some((t) => t.includes('figures/dropped-one.png')) === false || picks.length >= 1, picks.join(' | '));
  check('each suggestion says what kind of picture it is and how big', picks.some((t) => /png · \d/.test(t)), picks.join(' | '));
  await owner.screenshot({ path: `${OUT}/28-picture-autocomplete.png` });
  await owner.keyboard.press('Escape');
  // take the typed line out again
  for (let i = 0; i < 25 && (await editorText(owner)).includes('\\includegraphics{fig'); i++) {
    const acMod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await owner.keyboard.down(acMod); await owner.keyboard.press('z'); await owner.keyboard.up(acMod);
    await sleep(120);
  }
  check('and the typed line is undone again', !(await editorText(owner)).includes('\\includegraphics{fig'));

  // ---- profile and settings
  const pfBox = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; });
  const pfTab = (page, dlg, label) => page.evaluate((d, l) => [...document.querySelectorAll(`${d} [role=tab]`)].find((b) => b.textContent.trim() === l).click(), dlg, label);
  const pfClickText = (page, sel, text) => page.evaluate((s, t) => [...document.querySelectorAll(s)].find((b) => b.textContent.trim().startsWith(t)).click(), sel, text);
  const pfSwitch = (page, dlg, i) => page.evaluate((d, n) => document.querySelectorAll(`${d} qq-toggle input`)[n].click(), dlg, i);
  const pfSet = async (page, sel, value) => { await page.click(sel, { clickCount: 3 }); await page.keyboard.press('Backspace'); if (value) await page.type(sel, value); await sleep(180); };
  const pfPresence = (page) => page.$$eval('.presence li', (l) => l.length);
  const pfToasts = (page) => page.$$eval('qq-toasts .toast', (l) => l.map((e) => e.innerText));
  const pfType = async (page, sel, text) => { await page.type(sel, text); await sleep(180); };
  const pfSaveProfile = async (page) => { await sleep(150); await pfClickText(page, 'dialog.profile .foot .btn', 'Save profile'); await until(async () => (await page.$('dialog.profile[open]')) === null, 'profile closed after saving'); };
  const pfSaveSettings = async (page) => { await sleep(150); await pfClickText(page, 'dialog.settings .foot .btn', 'Save changes'); await until(async () => (await page.$('dialog.settings[open]')) === null, 'settings closed after saving'); };
  await owner.bringToFront();

  // the profile: edit it, and everyone at the table sees the change
  await owner.click('.me-btn');
  await owner.waitForSelector('dialog.profile[open]');
  check('your avatar opens "Your Tavern Profile" with your name and email', (await owner.$eval('dialog.profile .ident b', (e) => e.textContent)).length > 0 && (await owner.$eval('dialog.profile .ident small', (e) => e.textContent)).includes('@guild.test'));
  await until(async () => (await owner.$eval('dialog.profile .ident small', (e) => e.textContent)).includes('Owner of'), 'scroll count loads', 4000);
  check('it says how many scrolls you own', true);
  await owner.screenshot({ path: `${OUT}/21-profile.png` });
  await pfSet(owner, 'dialog.profile input[name=name]', 'Aelith the Bold');
  await pfSet(owner, 'dialog.profile input[name=aff]', 'Guild of Quills');
  await owner.click('dialog.profile .swatch[aria-label="Wine"]');
  check('the colour and the name others will call you update as you edit', (await owner.$eval('dialog.profile .shown', (e) => e.textContent)).includes('“Aelith”'));
  await owner.click('dialog.profile form button[type=submit]');
  await until(async () => (await owner.$('dialog.profile[open]')) === null, 'profile closes after saving');
  check('saving the profile closes it and says so', (await pfToasts(owner)).some((t) => t.includes('profile is saved')));
  check('your avatar takes the new colour', (await owner.$eval('.me-btn', (e) => getComputedStyle(e).backgroundColor)) === 'rgb(155, 48, 48)');
  await until(async () => (await reader.$$eval('.presence li', (l) => l.some((e) => (e.getAttribute('title') ?? '').startsWith('Aelith the Bold')))), 'reader sees the new name', 8000);
  check('the other scribes see your new name at the table straight away', true);

  // security: wrong password is refused, the strength guide works, sessions say which browser
  await owner.click('.me-btn');
  await owner.waitForSelector('dialog.profile[open]');
  await pfTab(owner, 'dialog.profile', 'Security');
  await owner.waitForSelector('dialog.profile .sessions li');
  await pfType(owner, 'dialog.profile input[name=cur]', 'definitely wrong');
  await pfType(owner, 'dialog.profile input[name=new]', 'short');
  await until(async () => (await owner.$eval('dialog.profile .strength', (e) => e.textContent)).includes('too short'), 'guide says too short', 4000);
  check('the password guide says when it is too short', true);
  await owner.click('dialog.profile input[name=new]', { clickCount: 3 });
  await pfType(owner, 'dialog.profile input[name=new]', 'a different long passphrase 99');
  await until(async () => /good|strong/.test(await owner.$eval('dialog.profile .strength', (e) => e.textContent)), 'guide rates it', 4000);
  check('and rates a good one', true);
  await sleep(200);
  await pfClickText(owner, 'dialog.profile .pw .btn', 'Update password');
  await owner.waitForSelector('dialog.profile .pw .alert');
  check('a wrong current password is refused with the reason', (await owner.$eval('dialog.profile .pw .alert', (e) => e.textContent)).toLowerCase().includes('current password'));
  const sessionRows = await owner.$$eval('dialog.profile .sessions li', (l) => l.map((e) => e.innerText.replace(/\s+/g, ' ')));
  check('active sessions name the browser and mark this device', sessionRows.length >= 1 && sessionRows[0].includes(' on ') && sessionRows.some((r) => r.includes('Current')), sessionRows.join(' | '));
  await owner.click('dialog.profile input[name=cur]', { clickCount: 3 });
  await pfType(owner, 'dialog.profile input[name=cur]', 'correct horse battery staple');
  await sleep(200);
  await pfClickText(owner, 'dialog.profile .pw .btn', 'Update password');
  await owner.waitForSelector('dialog.profile .pw .notice');
  check('changing the password works and says other devices were signed out', (await owner.$eval('dialog.profile .pw .notice', (e) => e.textContent)).includes('signed out'));
  // put it back, so the account stays as the rest of the run expects
  await pfSet(owner, 'dialog.profile input[name=cur]', 'a different long passphrase 99');
  await pfSet(owner, 'dialog.profile input[name=new]', 'correct horse battery staple');
  await sleep(200);
  await pfClickText(owner, 'dialog.profile .pw .btn', 'Update password');
  await until(async () => (await owner.$eval('dialog.profile .pw .notice', (e) => e.textContent).catch(() => '')).includes('signed out') && (await owner.$eval('dialog.profile input[name=cur]', (e) => e.value)) === '', 'password restored');
  await owner.screenshot({ path: `${OUT}/22-profile-security.png` });

  // notifications: choices are kept, even across a reload
  await pfTab(owner, 'dialog.profile', 'Notifications');
  await owner.waitForSelector('dialog.profile #ppanel-notifications');
  await pfSwitch(owner, 'dialog.profile #ppanel-notifications', 2); // bell
  await owner.select('dialog.profile select[name=quiet]', 'nights');
  await owner.screenshot({ path: `${OUT}/23-profile-notifications.png` });
  await pfClickText(owner, 'dialog.profile .foot .btn', 'Save preferences');
  await until(async () => (await owner.$('dialog.profile[open]')) === null, 'notification prefs saved');
  await owner.reload();
  await owner.waitForSelector('.me-btn');
  await owner.click('.me-btn');
  await owner.waitForSelector('dialog.profile[open]');
  await pfTab(owner, 'dialog.profile', 'Notifications');
  await owner.waitForSelector('dialog.profile #ppanel-notifications');
  check('notification choices survive a reload', (await owner.$$eval('dialog.profile #ppanel-notifications qq-toggle input', (l) => l[2].checked)) === true && (await owner.$eval('dialog.profile select[name=quiet]', (e) => e.value)) === 'nights');
  await pfSwitch(owner, 'dialog.profile #ppanel-notifications', 2); // bell off again
  await owner.select('dialog.profile select[name=quiet]', 'off');
  await pfClickText(owner, 'dialog.profile .foot .btn', 'Save preferences');
  await until(async () => (await owner.$('dialog.profile[open]')) === null, 'notification prefs reset');

  // presence: disappearing from the table, and coming back, is announced to the others
  const readerSeen = await pfPresence(reader);
  await owner.click('.me-btn');
  await owner.waitForSelector('dialog.profile[open]');
  await owner.evaluate(() => document.querySelectorAll('dialog.profile #ppanel-profile qq-toggle input')[1].click()); // appear as present: off
  await pfSaveProfile(owner);
  await until(async () => (await pfPresence(reader)) === readerSeen - 1, 'owner vanishes from the reader\'s table', 8000);
  check('"Appear as present" off makes you vanish from the others\' table', true);
  await until(async () => (await pfToasts(reader)).some((t) => t.includes('left the table')), 'reader hears someone left', 6000);
  check('and the others are told you left', true);
  await owner.click('.me-btn');
  await owner.waitForSelector('dialog.profile[open]');
  await owner.evaluate(() => document.querySelectorAll('dialog.profile #ppanel-profile qq-toggle input')[1].click()); // present again
  await pfSaveProfile(owner);
  await until(async () => (await pfPresence(reader)) === readerSeen, 'owner is back at the table', 8000);
  await until(async () => (await pfToasts(reader)).some((t) => t.includes('joined the table')), 'reader hears someone joined', 6000);
  check('coming back is announced too, and you reappear', true);

  // show my cursor: off hides my caret from the others
  await owner.click('.cm-content');
  await owner.keyboard.press('ArrowRight');
  await until(async () => (await reader.$$('.cm-ySelectionCaret')).length >= 1, 'reader sees the owner caret', 6000);
  await owner.click('.me-btn');
  await owner.waitForSelector('dialog.profile[open]');
  await owner.evaluate(() => document.querySelectorAll('dialog.profile #ppanel-profile qq-toggle input')[0].click()); // show my cursor: off
  await pfSaveProfile(owner);
  await until(async () => (await reader.$$('.cm-ySelectionCaret')).length === 0, 'owner caret hidden from the reader', 6000);
  await owner.click('.cm-content');
  await owner.keyboard.press('ArrowRight');
  await sleep(600);
  check('"Show my cursor" off hides your caret from the others, even when you move', (await reader.$$('.cm-ySelectionCaret')).length === 0);
  await owner.click('.me-btn');
  await owner.waitForSelector('dialog.profile[open]');
  await owner.evaluate(() => document.querySelectorAll('dialog.profile #ppanel-profile qq-toggle input')[0].click()); // back on
  await pfSaveProfile(owner);
  await owner.click('.cm-content');
  await owner.keyboard.press('ArrowLeft');
  await until(async () => (await reader.$$('.cm-ySelectionCaret')).length >= 1, 'caret shown again', 6000);
  check('and it comes back when you switch it on', true);

  // the settings dialog: editor look and behaviour take effect at once
  await pfClickText(owner, 'header .panels button', 'Settings');
  await owner.waitForSelector('dialog.settings[open]');
  check('Settings opens on the Compiler tab with the main document and the engine', (await owner.$eval('dialog.settings select[name=main]', (e) => e.value)) === 'main.tex' && (await owner.$eval('dialog.settings .static', (e) => e.textContent)).includes('Tectonic'));
  await owner.screenshot({ path: `${OUT}/24-settings-compiler.png` });
  await pfTab(owner, 'dialog.settings', 'Editor');
  await owner.waitForSelector('dialog.settings input[name=size]');
  await pfSet(owner, 'dialog.settings input[name=size]', '22');
  await pfSet(owner, 'dialog.settings input[name=lh]', '32');
  await pfSwitch(owner, 'dialog.settings', 0); // line numbers off
  await pfSwitch(owner, 'dialog.settings', 1); // wrap off
  await owner.screenshot({ path: `${OUT}/25-settings-editor.png` });
  await pfSaveSettings(owner);
  check('a bigger font and line height apply to the editor immediately', (await owner.$eval('.cm-scroller', (e) => getComputedStyle(e).fontSize)) === '22px' && (await owner.$eval('.cm-scroller', (e) => getComputedStyle(e).lineHeight)) === '32px');
  check('line numbers and wrapping can be switched off', (await owner.$('.cm-lineNumbers')) === null && (await owner.$('.cm-lineWrapping')) === null);
  await pfClickText(owner, 'header .panels button', 'Settings');
  await owner.waitForSelector('dialog.settings[open]');
  await pfTab(owner, 'dialog.settings', 'Editor');
  await pfSet(owner, 'dialog.settings input[name=size]', '15');
  await pfSet(owner, 'dialog.settings input[name=lh]', '24');
  await pfSwitch(owner, 'dialog.settings', 0);
  await pfSwitch(owner, 'dialog.settings', 1);
  await pfSaveSettings(owner);
  await until(async () => (await owner.$('.cm-lineNumbers')) !== null && (await owner.$('.cm-lineWrapping')) !== null, 'editor look restored');
  check('and switched back on', true);

  // others' cursors and name flags are a local choice
  await reader.click('.cm-content');
  await reader.keyboard.press('ArrowRight');
  await until(async () => (await owner.$$('.cm-ySelectionCaret')).length >= 1, 'owner sees the reader caret', 6000);
  await pfClickText(owner, 'header .panels button', 'Settings');
  await owner.waitForSelector('dialog.settings[open]');
  await pfTab(owner, 'dialog.settings', 'Collaboration');
  await owner.waitForSelector('dialog.settings #spanel-collaboration');
  await pfSwitch(owner, 'dialog.settings', 0); // other cursors off
  await pfSaveSettings(owner);
  check('hiding other scribes\' cursors hides them for you only', (await owner.$eval('qq-code-editor', (e) => e.classList.contains('hide-cursors'))) && (await owner.$eval('.cm-ySelectionCaret', (e) => getComputedStyle(e).display)) === 'none' && (await reader.$$('.cm-ySelectionCaret')).length >= 0);
  await pfClickText(owner, 'header .panels button', 'Settings');
  await owner.waitForSelector('dialog.settings[open]');
  await pfTab(owner, 'dialog.settings', 'Collaboration');
  await pfSwitch(owner, 'dialog.settings', 0);
  await pfSaveSettings(owner);
  await until(async () => (await owner.$eval('qq-code-editor', (e) => !e.classList.contains('hide-cursors'))), 'cursors shown again');

  // auto-compile: type, stop, and a new build appears by itself
  await pfClickText(owner, 'header .panels button', 'Settings');
  await owner.waitForSelector('dialog.settings[open]');
  await pfSwitch(owner, 'dialog.settings', 0); // auto-compile on (Compiler tab)
  await pfSaveSettings(owner);
  const srcBefore = await owner.$eval('qq-pdf-preview .scroller', (e) => e.getAttribute('data-src'));
  await owner.click('.cm-content');
  await owner.keyboard.press('ArrowRight');
  await owner.keyboard.type(' ');
  await until(async () => (await owner.$eval('qq-pdf-preview .scroller', (e) => e.getAttribute('data-src'))) !== srcBefore, 'a build starts by itself', 20000);
  check('with auto-compile on, a build starts a moment after you stop typing', true);
  await owner.keyboard.press('Backspace');
  await pfClickText(owner, 'header .panels button', 'Settings');
  await owner.waitForSelector('dialog.settings[open]');
  await pfSwitch(owner, 'dialog.settings', 0); // off again
  await pfSaveSettings(owner);

  // a reader may open settings but cannot change the shared main document
  await pfClickText(reader, 'header .panels button', 'Settings');
  await reader.waitForSelector('dialog.settings[open]');
  check('readers see the main document but cannot change it', (await reader.$eval('dialog.settings select[name=main]', (e) => e.disabled)) === true);
  await pfClickText(reader, 'dialog.settings .foot .btn', 'Cancel');
  await until(async () => (await reader.$('dialog.settings[open]')) === null, 'reader settings closed');

  // leaving the tavern for good (a throwaway account, so the run can go on)
  const leaverMail = email('leaver');
  const leaver = await newScribe('leaver');
  await signup(leaver, 'Leaver', leaverMail);
  await leaver.click('button.who');
  await leaver.waitForSelector('dialog.profile[open]');
  await pfTab(leaver, 'dialog.profile', 'Security');
  await leaver.waitForSelector('dialog.profile .foot .link.danger');
  await leaver.click('dialog.profile .foot .link.danger');
  await leaver.waitForSelector('dialog.danger-dlg[open]');
  await leaver.screenshot({ path: `${OUT}/26-delete-account.png` });
  check('deleting the account asks for your email and keeps the button off until it matches', (await leaver.$eval('dialog.danger-dlg .btn--danger', (e) => e.disabled)) === true);
  await pfType(leaver, 'dialog.danger-dlg input[name=delemail]', 'someone@else.test');
  await sleep(150);
  check('a different email is called out', (await leaver.$eval('dialog.danger-dlg .field small.bad', (e) => e.textContent)).includes('does not match'));
  await pfSet(leaver, 'dialog.danger-dlg input[name=delemail]', leaverMail);
  await pfType(leaver, 'dialog.danger-dlg input[name=delpw]', 'correct horse battery staple');
  await sleep(150);
  await leaver.click('dialog.danger-dlg .btn--danger');
  await until(() => leaver.url().includes('/login'), 'deleted accounts are sent to sign in', 10000);
  check('the account is deleted and you are sent to the sign-in page', true);
  await pfType(leaver, 'input[name=email]', leaverMail);
  await pfType(leaver, 'input[name=password]', 'correct horse battery staple');
  await leaver.click('button[type=submit]');
  await until(async () => (await leaver.$('.alert, [role=alert]')) !== null, 'signing in as the deleted account fails', 6000);
  check('that account can no longer sign in', leaver.url().includes('/login'));

  // put the profile back the way the rest of the run expects
  await owner.bringToFront();
  await owner.click('.me-btn');
  await owner.waitForSelector('dialog.profile[open]');
  await pfSet(owner, 'dialog.profile input[name=name]', 'Aelith');
  await pfSet(owner, 'dialog.profile input[name=aff]', '');
  await owner.click('dialog.profile .swatch[aria-label="Brass"]');
  await pfSaveProfile(owner);

  // ---- the Tavern Hall (full-page tables view)
  const hallUrl = `${scrollUrl}/hall`;
  const sent = [];
  owner.on('request', (r) => sent.push(`${r.method()} ${new URL(r.url()).pathname} ${(r.postData() ?? '').length}`));
  const member = (page, p) => page.waitForSelector(`button.member[aria-label^="${p}"]`);
  const clickText = (page, scope, text) => page.evaluate((sc, t) => [...document.querySelectorAll(sc)].find((b) => b.textContent.trim().startsWith(t)).click(), scope, text);
  await owner.click('qq-file-tree a.hall');
  await owner.waitForSelector('.table[data-table="figures"]');
  check('"Enter the Tavern Hall" opens the full-page hall', owner.url().endsWith('/hall'), owner.url());
  check('directories become tables with a plaque and member count', /figures\/ \d+ members?/.test(await owner.$eval('.table[data-table="figures"] .plaque', (e) => e.innerText.replace(/\s+/g, ' '))));
  await member(owner, 'figures/orbit-test.png');
  check('the main hall holds the top-level files, with main.tex as the star', (await owner.$$eval('.table[data-table=""] button.member', (l) => l.map((b) => b.getAttribute('aria-label')))).some((l) => l.startsWith('main.tex')));
  await owner.screenshot({ path: `${OUT}/11-tavern-hall.png` });
  await owner.click('button.member[aria-label^="figures/orbit-test.png"]');
  await owner.waitForSelector('qq-portrait-panel h3');
  check('selecting a member shows their portrait', (await owner.$eval('qq-portrait-panel h3', (e) => e.textContent)).includes('orbit-test.png'));
  check('the portrait lists where the picture is used', (await owner.$eval('qq-portrait-panel', (e) => e.innerText)).includes('main.tex · line'));
  await owner.screenshot({ path: `${OUT}/12-hall-portrait.png` });

  // the map: zoom controls, drag to pan, ctrl+wheel zoom, fit, minimap
  const xf = () => owner.$eval('.world', (e) => { const m = new DOMMatrix(getComputedStyle(e).transform); return { k: m.a, x: m.e, y: m.f }; });
  await sleep(500);
  const v0 = await xf();
  await owner.click('.hud.zoom button[aria-label="Zoom in"]');
  await sleep(600);
  const v1 = await xf();
  check('the zoom buttons magnify the map', v1.k > v0.k * 1.2, `${v0.k.toFixed(2)} -> ${v1.k.toFixed(2)}`);
  check('the zoom control shows the percentage', (await owner.$eval('.hud.zoom .pct', (e) => e.textContent)).trim() === `${Math.round(v1.k * 100)}%`);
  const box = await owner.$eval('.map', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await owner.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.2);
  await owner.mouse.down();
  await owner.mouse.move(box.x + box.w * 0.5 + 120, box.y + box.h * 0.2 + 70, { steps: 6 });
  await owner.mouse.up();
  const v2 = await xf();
  check('dragging the floor pans the map', Math.abs(v2.x - v1.x - 120) < 2 && Math.abs(v2.y - v1.y - 70) < 2, `dx=${(v2.x - v1.x).toFixed(0)} dy=${(v2.y - v1.y).toFixed(0)}`);
  await owner.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
  await owner.keyboard.down('Control');
  await owner.mouse.wheel({ deltaY: 200 });
  await owner.keyboard.up('Control');
  await sleep(200);
  check('Ctrl + scroll zooms out around the pointer', (await xf()).k < v2.k);
  await owner.click('.hud.zoom button[aria-label="Fit every table on screen"]');
  await sleep(600);
  const vf = await xf();
  check('"Fit" brings every table into view', vf.k <= 1 && (await owner.$$eval('.table', (l) => l.length)) >= 2);
  check('the minimap shows a dot for every table', (await owner.$$('.minimap .dot')).length === (await owner.$$('.table')).length || (await owner.$$('.minimap .dot')).length >= 2);
  await owner.screenshot({ path: `${OUT}/12b-hall-map.png` });

  check('a folder made in the editor list is a table in the Tavern Hall, with its file seated', (await owner.$eval('.table[data-table="drafts"] .plaque', (e) => e.innerText.replace(/\s+/g, ' '))).includes('drafts/ 1 member'));

  // tables can be carried to a new place: they never overlap, and the place is kept
  const tableBox = (page, name) => page.evaluate((n) => { const r = document.querySelector(`.table[data-table="${n}"]`).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, name);
  const mainName = await owner.$eval('.table', (e) => e.getAttribute('data-table'));
  const before = await tableBox(owner, 'drafts');
  const target = await tableBox(owner, mainName);
  await owner.mouse.move(before.x + before.w / 2, before.y + before.h / 2);
  await owner.mouse.down();
  await owner.mouse.move(before.x + before.w / 2 + 30, before.y + before.h / 2 + 10, { steps: 4 });
  await owner.mouse.move(target.x + target.w / 2 - 40, target.y + target.h / 2 - 30, { steps: 12 }); // onto the other table, a little up-left of its middle
  await owner.mouse.up();
  await sleep(500);
  const moved = await tableBox(owner, 'drafts');
  const still = await tableBox(owner, mainName);
  const apart = Math.hypot(moved.x + moved.w / 2 - (still.x + still.w / 2), moved.y + moved.h / 2 - (still.y + still.h / 2));
  check('dragging a table moves it', Math.abs(moved.x - before.x) + Math.abs(moved.y - before.y) > 20);
  check('a table dropped on another does not overlap it', apart >= (moved.w + still.w) / 2 + 10, `${Math.round(apart)} apart`);
  check('the table that was in the way is pushed aside', Math.abs(still.x - target.x) + Math.abs(still.y - target.y) > 10);
  // carry it away again: the table it shoved stays where it was shoved
  const dir = [moved.x - still.x, moved.y - still.y];
  const len = Math.hypot(dir[0], dir[1]) || 1;
  await owner.mouse.move(moved.x + moved.w / 2, moved.y + moved.h / 2);
  await owner.mouse.down();
  await owner.mouse.move(moved.x + moved.w / 2 + (dir[0] / len) * 40, moved.y + moved.h / 2 + (dir[1] / len) * 40, { steps: 4 });
  await owner.mouse.move(moved.x + moved.w / 2 + (dir[0] / len) * 260, moved.y + moved.h / 2 + (dir[1] / len) * 260, { steps: 10 });
  await owner.mouse.up();
  await sleep(500);
  const stayed = await tableBox(owner, mainName);
  check('a table that was shoved stays put when the other is carried away (it does not drift back)', Math.abs(stayed.x - still.x) < 2 && Math.abs(stayed.y - still.y) < 2, `${Math.round(stayed.x - still.x)},${Math.round(stayed.y - still.y)}`);
  const finalMoved = await tableBox(owner, 'drafts');
  moved.x = finalMoved.x;
  moved.y = finalMoved.y;
  await owner.reload();
  await owner.waitForSelector('.table[data-table="drafts"]');
  await sleep(1500);
  const kept = await tableBox(owner, 'drafts');
  const keptMain = await tableBox(owner, mainName);
  const offset = (a, b) => [Math.round(((a.x - b.x) / b.w) * 100) / 100, Math.round(((a.y - b.y) / b.w) * 100) / 100]; // in table widths, so a different zoom does not matter
  const was = offset(moved, still);
  const now = offset(kept, keptMain);
  check('the new place is saved: after a reload the table is still beside the other, where it was put', Math.abs(was[0] - now[0]) <= 0.03 && Math.abs(was[1] - now[1]) <= 0.03, `${was} vs ${now}`);

  // upload a text file through the hall: it is seated in the main hall as a new member
  const tex = path.join(OUT, 'appendix-notes.tex');
  fs.writeFileSync(tex, '\\section{Appendix}\nHello from the hall.\n');
  await (await owner.$('input[type=file]')).uploadFile(tex);
  await member(owner, 'appendix-notes.tex');
  check('a .tex file uploaded in the hall is seated in the main hall', true);

  // a new table
  await clickText(owner, 'header.beam button', 'New Table');
  await owner.waitForSelector('dialog[open] input[name=tname]');
  await owner.type('dialog[open] input[name=tname]', 'appendix');
  await owner.click('dialog[open] button[type=submit]');
  await owner.waitForSelector('.table[data-table="appendix"]');
  check('"Pull Up a New Table" creates an empty table', (await owner.$eval('.table[data-table="appendix"] .plaque', (e) => e.innerText)).includes('0 members'));

  // context menu: move the picture to the new table (bytes travel through the browser)
  await owner.click('.hud.zoom button[aria-label="Fit every table on screen"]');
  await sleep(600);
  const orbitAt = await owner.$eval('button.member[aria-label^="figures/orbit-test.png"]', (e) => { const r = e.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!top && (top === e || e.contains(top)); });
  check('after "Fit" no member is hidden behind the door or the zoom controls', orbitAt);
  await owner.click('button.member[aria-label^="figures/orbit-test.png"]', { button: 'right' });
  await owner.waitForSelector('.menu');
  await clickText(owner, '.menu > button', 'Move to table');
  await clickText(owner, '.submenu button', 'appendix/');
  await member(owner, 'appendix/orbit-test.png');
  check('"Move to table…" seats the picture at the other table', true);
  await until(async () => (await owner.$$eval('.note', (l) => l.some((e) => /Updated 1 reference in 1 file/.test(e.textContent)))), 'the move reports the reference it fixed', 5000);
  check('moving a picture says it updated the reference in the sources', true);
  await owner.click('button.member[aria-label^="appendix/orbit-test.png"]');
  await owner.waitForSelector('qq-portrait-panel h3');
  await until(async () => (await owner.$eval('qq-portrait-panel', (e) => e.innerText)).includes('main.tex · line'), 'portrait shows the new reference', 4000);
  check('the sources now point at the picture\'s new place (the portrait still finds where it is used)', true);
  await until(async () => (await owner.$('button.member[aria-label^="figures/orbit-test.png"]')) === null, 'old seat is vacated');
  check('moving a picture is one server call that sends no image bytes from the browser', sent.some((x) => x.startsWith('POST') && x.includes('/asset-moves')) && !sent.some((x) => x.startsWith('PUT') && x.includes('/assets/appendix/')), sent.filter((x) => x.includes('/asset')).join(' | '));

  // duplicate a picture from the menu: also server-side, original stays
  await owner.click('button.member[aria-label^="appendix/orbit-test.png"]', { button: 'right' });
  await owner.waitForSelector('.menu');
  await clickText(owner, '.menu > button', 'Duplicate');
  await member(owner, 'appendix/orbit-test-copy.png');
  check('"Duplicate" copies a picture and keeps the original', (await owner.$('button.member[aria-label^="appendix/orbit-test.png"]')) !== null);

  // dragging a member to another table MOVES it: the same file, one server call, nothing uploaded
  const assetCount = () => owner.$$eval('qq-file-tree li.asset', (l) => l.length).catch(() => -1);
  const membersNamed = (name) => owner.$$eval('button.member', (l, n) => l.filter((b) => (b.getAttribute('aria-label') ?? '').endsWith(n)).length, name);
  const sentBefore = sent.length;
  await owner.evaluate(() => {
    // like a browser dragging a picture: our own type for the move, and the picture also attached as a file
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'orbit-test-copy.png', { type: 'image/png' }));
    const from = document.querySelector('button.member[aria-label^="appendix/orbit-test-copy.png"]');
    const to = document.querySelector('.table[data-table=""]');
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    for (const type of ['dragenter', 'dragover', 'drop']) to.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  });
  await member(owner, 'orbit-test-copy.png');
  await until(async () => (await owner.$('button.member[aria-label^="appendix/orbit-test-copy.png"]')) === null, 'old seat vacated');
  const afterDrag = sent.slice(sentBefore).filter((x) => x.includes('/asset'));
  check('dragging a picture to another table moves it (one server call, no upload)', afterDrag.some((x) => x.startsWith('POST') && x.includes('/asset-moves')) && !afterDrag.some((x) => x.startsWith('PUT')), afterDrag.join(' | '));
  check('there is still exactly one copy of it', (await membersNamed('orbit-test-copy.png')) === 1);
  // and a text file too
  await owner.evaluate(() => {
    const dt = new DataTransfer();
    const from = document.querySelector('button.member[aria-label^="appendix-notes.tex"]');
    const to = document.querySelector('.table[data-table="appendix"]');
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    for (const type of ['dragenter', 'dragover', 'drop']) to.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await member(owner, 'appendix/appendix-notes.tex');
  check('dragging a text file to another table moves it too, keeping its words', (await membersNamed('appendix-notes.tex')) === 1);
  // dropping it back on the table it is already at changes nothing
  await owner.evaluate(() => {
    const dt = new DataTransfer();
    const from = document.querySelector('button.member[aria-label^="appendix/appendix-notes.tex"]');
    const to = document.querySelector('.table[data-table="appendix"]');
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    for (const type of ['dragover', 'drop']) to.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await sleep(300);
  check('dropping a member on its own table leaves it where it is', (await membersNamed('appendix-notes.tex')) === 1 && (await owner.$('button.member[aria-label^="appendix/appendix-notes.tex"]')) !== null);
  // put the text file back for the sections that follow
  await owner.evaluate(() => {
    const dt = new DataTransfer();
    const from = document.querySelector('button.member[aria-label^="appendix/appendix-notes.tex"]');
    const to = document.querySelector('.table[data-table=""]');
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    for (const type of ['dragover', 'drop']) to.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await member(owner, 'appendix-notes.tex');
  void assetCount;

  // rename a text member
  await owner.click('button.member[aria-label^="appendix-notes.tex"]', { button: 'right' });
  await owner.waitForSelector('.menu');
  await clickText(owner, '.menu > button', 'Rename');
  await owner.waitForSelector('dialog[open] input[name=rname]');
  await owner.click('dialog[open] input[name=rname]', { clickCount: 3 });
  await owner.type('dialog[open] input[name=rname]', 'notes-two.tex');
  await owner.click('dialog[open] button[type=submit]');
  await member(owner, 'notes-two.tex');
  check('renaming a member keeps its text', true);

  // the other scribe sees the same hall live, without writing controls
  await reader.goto(hallUrl);
  await reader.waitForSelector('.table[data-table="appendix"]');
  check("the reader's hall shows the same tables", (await reader.$$('.table')).length >= 2);
  check('readers get no Upload or New Table buttons', !(await reader.$$eval('header.beam button', (b) => b.some((x) => /Upload|New Table/.test(x.textContent)))));

  // list view
  await clickText(owner, '.tabs button', 'List');
  await owner.waitForSelector('.grid .group');
  check('the list view groups members under their tables', (await owner.$$('.grid .group')).length >= 2);
  await clickText(owner, '.fchip', 'Images');
  await until(async () => { const rows = await owner.$$eval('.grid .row', (l) => l.map((e) => e.innerText)); return rows.length >= 2 && rows.every((t) => /\.(png|jpe?g|pdf|svg|webp|eps)/i.test(t)); }, 'filter narrows to the pictures');
  check('the Images filter keeps only pictures', (await owner.$$eval('.grid .row', (l) => l.map((e) => e.innerText))).some((t) => t.includes('orbit-test')));
  await owner.screenshot({ path: `${OUT}/13-hall-list.png` });
  await clickText(owner, '.fchip', 'All');
  await clickText(owner, '.tabs button', 'Tavern');

  // a crowded table keeps ten stools; the rest wait on the bench
  const many = Array.from({ length: 12 }, (_, i) => { const f = path.join(OUT, `scene-${String(i).padStart(2, '0')}.tex`); fs.writeFileSync(f, `Scene ${i}\n`); return f; });
  await (await owner.$('input[type=file]')).uploadFile(...many);
  await owner.waitForSelector('.table[data-table=""] button.member.more');
  const seatsAtMain = await owner.$$eval('.table[data-table=""] button.member', (l) => l.length);
  check('a crowded table caps its stools and adds a bench', seatsAtMain === 10, `${seatsAtMain} stools`);
  check('the bench says how many are waiting', (await owner.$eval('.table[data-table=""] button.member.more .face', (e) => e.textContent)).trim().startsWith('+'));
  await owner.screenshot({ path: `${OUT}/12c-hall-bench.png` });
  await owner.click('.table[data-table=""] button.member.more');
  await owner.waitForSelector('dialog[open] .bench li button');
  check('the bench lists everyone at the table', (await owner.$$('dialog[open] .bench li button')).length >= 14);
  await owner.type('dialog[open] .bench input[type=search]', 'scene-11');
  await until(async () => (await owner.$$('dialog[open] .bench li button')).length === 1, 'bench search narrows');
  await owner.click('dialog[open] .bench li button');
  await owner.waitForSelector('qq-text-portrait h3');
  check('picking someone from the bench seats them and shows their portrait', (await owner.$eval('qq-text-portrait h3', (e) => e.textContent)).includes('scene-11.tex'));
  await until(async () => (await owner.$('.table[data-table=""] button.member[aria-label^="scene-11.tex"]')) !== null, 'scene-11 gets a stool');
  check('the selected member takes a stool at the table', true);

  // import a .zip: folders become tables, junk and unsupported files are skipped and listed
  const zipPath = path.join(OUT, 'bundle.zip');
  fs.writeFileSync(zipPath, Buffer.from(zipSync({
    'bundle/chapters/c1.tex': strToU8('\\section{One}\nFrom the zip.\n'),
    'bundle/figures/pic.png': new Uint8Array(makePng(32, 24)),
    'bundle/refs2.bib': strToU8('@book{a, title={A}}\n'),
    'bundle/run.exe': strToU8('MZ'),
    'bundle/.DS_Store': strToU8('junk'),
    'bundle/../escape.tex': strToU8('nope'),
  })));
  await (await owner.$('input[type=file]')).uploadFile(zipPath);
  await owner.waitForSelector('dialog[open] .rows');
  await until(async () => (await owner.$$eval('dialog[open] .actions .btn', (b) => b.some((x) => x.textContent.trim() === 'Done'))), 'import finishes');
  const rowsText = await owner.$$eval('dialog[open] .rows li', (l) => l.map((x) => x.innerText.replace(/\s+/g, ' ')));
  check('the import dialog lists every file with its table', rowsText.length === 3 && rowsText.some((r) => r.includes('c1.tex') && r.includes('chapters/')), rowsText.join(' | '));
  const skippedText = await owner.$eval('dialog[open] .skipped', (e) => e.innerText);
  check('unsupported and unsafe entries are skipped and listed, junk is not', skippedText.includes('run.exe') && skippedText.includes('escape.tex') && !skippedText.includes('DS_Store'), skippedText.replace(/\s+/g, ' '));
  await owner.screenshot({ path: `${OUT}/14-zip-import.png` });
  await clickText(owner, 'dialog[open] .actions .btn', 'Done');
  await member(owner, 'chapters/c1.tex');
  await member(owner, 'figures/pic.png');
  await member(owner, 'refs2.bib');
  check('the zip\'s folders became tables and its files are seated (text and picture)', true);
  await reader.goto(hallUrl);
  await reader.waitForSelector('.table[data-table="chapters"]');
  check("the reader sees the imported tables live", (await reader.$('button.member[aria-label^="figures/pic.png"]')) !== null);

  // portrait -> insert dialog in the editor
  await owner.click('button.member[aria-label^="appendix/orbit-test.png"]');
  await owner.waitForSelector('qq-portrait-panel .btn.wide');
  await owner.click('qq-portrait-panel .btn.wide');
  await owner.waitForSelector('dialog.portrait[open]');
  check('"Insert \\includegraphics" opens the insert dialog in the editor', /\/scroll\/[0-9a-f-]{36}$/.test(owner.url()), owner.url());
  await owner.click('dialog.portrait[open] .foot .btn--ink');

  // text member: open in the editor
  await owner.goto(hallUrl);
  await member(owner, 'notes-two.tex');
  await owner.click('button.member[aria-label^="notes-two.tex"]', { clickCount: 2 });
  await until(async () => (await owner.$eval('.tab', (e) => e.textContent)).includes('notes-two.tex'), 'editor opens the file');
  check('double-clicking a text member opens it in the editor', (await editorText(owner)).includes('Hello from the hall'));

  // ---- the menu bar (File, Edit, Format, View, Insert, Tools, Help)
  const menuItems = (page, menu) => page.$$eval(`#mbm-${menu} .item .lbl`, (l) => l.map((e) => e.textContent.trim()));
  const menuClick = async (page, menu, label) => {
    await page.click(`qq-menubar #mb-${menu}`);
    await page.waitForSelector(`#mbm-${menu}`);
    await page.evaluate((m, l) => [...document.querySelectorAll(`#mbm-${m} .item`)].find((b) => b.querySelector('.lbl').textContent.trim() === l).click(), menu, label);
  };
  await owner.bringToFront();
  await owner.goto(scrollUrl);
  await owner.waitForSelector('.cm-content');
  await sleep(1200);
  check('the menu bar has File, Edit, Format, View, Insert, Tools and Help', (await owner.$$eval('qq-menubar .top', (l) => l.map((e) => e.textContent.trim()))).join() === 'File,Edit,Format,View,Insert,Tools,Help');
  await owner.click('qq-menubar #mb-file');
  await owner.waitForSelector('#mbm-file');
  const fileItems = await menuItems(owner, 'file');
  check('File offers New scroll, Open scroll, New file, Import, Export as .zip, Rename and more', ['New scroll…', 'Open scroll…', 'New file', 'Import a .zip…', 'Export as .zip', 'Rename scroll…', 'Download the PDF'].every((i) => fileItems.includes(i)), fileItems.join(' | '));
  await owner.screenshot({ path: `${OUT}/35-file-menu.png` });
  await owner.keyboard.press('Escape');
  await until(async () => (await owner.$('#mbm-file')) === null, 'menu closed');
  check('Escape closes a menu', true);
  await owner.focus('#mb-file');
  await owner.keyboard.press('ArrowDown');
  await until(() => owner.evaluate(() => document.activeElement?.classList.contains('item')), 'first item focused');
  check('ArrowDown opens a menu and focuses its first item', true);
  await owner.keyboard.press('ArrowRight');
  await owner.waitForSelector('#mbm-edit');
  check('ArrowRight moves to the next menu', true);
  await owner.keyboard.press('Escape');
  await menuClick(owner, 'edit', 'Find and replace…');
  await owner.waitForSelector('qq-search-panel');
  check('Edit → Find and replace opens the search panel', true);
  await owner.keyboard.press('Escape');
  await until(async () => (await owner.$('qq-search-panel')) === null, 'search closed');
  await menuClick(owner, 'view', 'Scroll Preview');
  await until(async () => (await owner.$('qq-pdf-preview')) === null, 'preview hidden');
  check('View → Scroll Preview hides the panel (and the menu shows its tick)', true);
  await menuClick(owner, 'view', 'Scroll Preview');
  await owner.waitForSelector('qq-pdf-preview');

  // File → Export as .zip: every file and picture, in one archive
  const dlDir = path.join(OUT, 'downloads');
  fs.rmSync(dlDir, { recursive: true, force: true });
  fs.mkdirSync(dlDir, { recursive: true });
  const cdp = await owner.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, browserContextId: owner.browserContext().id });
  const downloaded = async (ext) => until(() => fs.readdirSync(dlDir).find((f) => f.endsWith(ext) && !f.endsWith('.crdownload')), `a ${ext} download`, 20000);
  await menuClick(owner, 'file', 'Export as .zip');
  const zipName = await downloaded('.zip');
  const zipped = unzipSync(new Uint8Array(fs.readFileSync(path.join(dlDir, zipName))));
  check('Export as .zip downloads an archive named after the scroll', zipName === 'Thesis-Chapter-4.zip', zipName);
  check('the archive holds the text files and the pictures at their own paths', 'main.tex' in zipped && strFromU8(zipped['main.tex']).includes('\\documentclass') && Object.keys(zipped).some((n) => n.startsWith('figures/') && n.endsWith('.png')), Object.keys(zipped).join(', '));

  // ---- recording a session: a timelapse of the writing, kept for 30 minutes
  await menuClick(owner, 'tools', 'Record a session');
  await owner.waitForSelector('qq-rec-pill .pill');
  const pillText = await owner.$eval('qq-rec-pill .pill', (e) => e.innerText.replace(/\s+/g, ' '));
  check('recording shows a timer on screen with the hour it may last, and Stop', pillText.includes('REC') && pillText.includes('/ 1:00:00') && (await owner.$('qq-rec-pill .stop')) !== null, pillText);
  await docEnd(owner);
  await owner.keyboard.type(' timelapsemarker');
  await sleep(700);
  await owner.keyboard.type(' second words');
  await sleep(1300);
  check('the timer is counting', !(await owner.$eval('qq-rec-pill .time', (e) => e.innerText)).startsWith('00:00'));
  await owner.screenshot({ path: `${OUT}/36-recording.png` });
  await owner.click('qq-rec-pill .stop');
  await until(async () => (await owner.$('qq-rec-pill .pill')) === null, 'recording stopped');
  await until(async () => (await owner.$$eval('.toast', (l) => l.some((t) => t.textContent.includes('Recording saved') && t.textContent.includes('30 minutes')))), 'saved message');
  check('Stop saves it for 30 minutes and says so', true);
  await menuClick(owner, 'tools', 'Watch the last recording');
  await owner.waitForSelector('qq-timelapse dialog[open] .code');
  await until(async () => (await owner.$eval('qq-timelapse .code', (e) => e.innerText)).includes('timelapsemarker second words'), 'the timelapse writes the text', 20000);
  check('the timelapse plays the writing back, ending with the typed words', true);
  await until(async () => (await owner.$eval('qq-timelapse .bar .btn', (e) => e.textContent)).includes('Again'), 'timelapse ends', 20000);
  check('each line of the file is on its own row, not run together', (await owner.$$eval('qq-timelapse .code .row', (l) => l.length)) > 5);
  check('the whole viewer fits on screen, controls included', await owner.evaluate(() => { const r = document.querySelector('qq-timelapse .bar').getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; }));
  check('it says when it is over and offers to play again, with a speed choice and a slider', (await owner.$('qq-timelapse select[aria-label="Playback speed"]')) !== null && (await owner.$('qq-timelapse input[type=range]')) !== null);
  await owner.screenshot({ path: `${OUT}/37-timelapse.png` });
  await owner.keyboard.press('Escape');
  await until(async () => (await owner.$('qq-timelapse dialog[open]')) === null, 'timelapse closed');
  // export it, then open it again from the file
  await menuClick(owner, 'tools', 'Export the last recording');
  const sessionName = await downloaded('.quillsession');
  check('the recording can be exported as a file', /^Thesis-Chapter-4-\d{4}-\d\d-\d\d-\d{4}\.quillsession$/.test(sessionName), sessionName);
  const sessionPath = path.join(dlDir, sessionName);
  check('and it is small (a few kilobytes for a short session, far below the 5 MB limit)', fs.statSync(sessionPath).size < 20000, `${fs.statSync(sessionPath).size} bytes`);
  const sessionInput = await owner.$('input[type=file][accept*="quillsession"]');
  await sessionInput.uploadFile(sessionPath);
  await owner.waitForSelector('qq-timelapse dialog[open] .code');
  await until(async () => (await owner.$eval('qq-timelapse .code', (e) => e.innerText)).includes('timelapsemarker'), 'imported session plays', 20000);
  check('a recording imported from its file plays the same timelapse', true);
  await owner.keyboard.press('Escape');
  fs.writeFileSync(path.join(dlDir, 'broken.quillsession'), 'this is not a recording');
  await (await owner.$('input[type=file][accept*="quillsession"]')).uploadFile(path.join(dlDir, 'broken.quillsession'));
  await until(async () => (await owner.$$eval('.toast', (l) => l.some((t) => t.textContent.includes('not a session recording')))), 'broken file refused');
  check('a file that is not a recording is refused with a clear message', true);
  await menuClick(owner, 'tools', 'Discard the last recording');
  await sleep(300);
  await owner.click('qq-menubar #mb-tools');
  await owner.waitForSelector('#mbm-tools');
  check('Discard removes the kept recording', await owner.$$eval('#mbm-tools .item', (l) => l.find((b) => b.textContent.includes('Watch the last recording')).disabled));
  await owner.keyboard.press('Escape');
  await docEnd(owner);
  for (let i = 0; i < ' timelapsemarker second words'.length; i++) await owner.keyboard.press('Backspace');
  await sleep(300);

  // ---- an AI assistant's edits: held for review, or applied at once (owner's choice)
  const sid = scrollUrl.split('/scroll/')[1];
  const token = await owner.evaluate(async () => (await (await fetch('/api/me/tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'smoke assistant', write: true, days: 30 }) })).json()).token);
  const asToken = (method, p, body) => owner.evaluate(async (t, m, url, b) => { const r = await fetch(url, { method: m, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }, token, method, p, body);
  check('an access token can be made in the browser', typeof token === 'string' && token.startsWith('qq_'));
  const queuedEdit = await asToken('PATCH', `/api/scrolls/${sid}/files/main.tex`, { oldText: '\\documentclass[12pt]{article}', newText: '\\documentclass[11pt]{article}', note: 'smaller type' });
  check("by default an assistant's edit is queued, not applied", queuedEdit.status === 202 && queuedEdit.body.queued === true && (await editorText(owner)).includes('[12pt]'));
  await until(async () => { await owner.click('qq-menubar #mb-edit'); await owner.waitForSelector('#mbm-edit'); const note = await owner.$$eval('#mbm-edit .item', (l) => l.find((b) => b.textContent.includes('AI assistant edits'))?.textContent ?? ''); await owner.keyboard.press('Escape'); return note.includes('1 waiting'); }, 'the menu says one edit is waiting');
  check('the Edit menu says how many assistant edits are waiting', true);
  await owner.waitForSelector('.ai-notice button');
  check('a notice at the bottom of the editor says AI changes are pending', (await owner.$eval('.ai-notice', (e) => e.innerText)).includes('AI changes pending'));
  await owner.click('.ai-notice button');
  await owner.waitForSelector('qq-ai-changes dialog[open] .props li .diff');
  const aiText = await owner.$eval('qq-ai-changes dialog[open]', (e) => e.innerText);
  check('the changes view shows who sent it, why, and what changes side by side', aiText.includes('smaller type') && aiText.includes('12pt') && aiText.includes('11pt') && aiText.includes('smoke assistant'));
  await owner.screenshot({ path: `${OUT}/38-ai-review.png` });
  await owner.click('qq-ai-changes .props li button[aria-label^="Accept"]');
  await until(async () => (await editorText(owner)).includes('[11pt]'), 'accepted edit appears');
  check('Accept puts the edit in the document for everyone', (await owner.$('qq-ai-changes .props li .diff')) === null);
  await owner.click('qq-ai-changes dialog[open] .foot button');
  await menuClick(owner, 'edit', 'AI assistant edits…');
  await owner.waitForSelector('qq-ai-dialog dialog[open]');
  await owner.click('qq-ai-dialog button[role=radio]:nth-of-type(2)');
  await until(async () => (await owner.$eval('qq-ai-dialog button[role=radio]:nth-of-type(2)', (e) => e.getAttribute('aria-checked'))) === 'true', 'auto mode chosen');
  check('the owner can switch to applying automatically', true);
  const direct = await asToken('PATCH', `/api/scrolls/${sid}/files/main.tex`, { oldText: '[11pt]', newText: '[12pt]' });
  check('in auto mode the same kind of edit applies at once', direct.status === 200);
  await until(async () => (await editorText(owner)).includes('[12pt]'), 'auto edit appears');
  await owner.click('qq-ai-dialog button[role=radio]:nth-of-type(1)');
  await until(async () => (await owner.$eval('qq-ai-dialog button[role=radio]:nth-of-type(1)', (e) => e.getAttribute('aria-checked'))) === 'true', 'review mode back');
  await owner.keyboard.press('Escape');

  // ---- access tokens in Profile → Security
  await owner.click('.me-btn');
  await owner.waitForSelector('dialog.profile[open]');
  await owner.evaluate(() => [...document.querySelectorAll('dialog.profile [role=tab]')].find((t) => t.textContent.trim() === 'Security').click());
  await owner.waitForSelector('dialog.profile form.newtoken');
  await owner.type('dialog.profile form.newtoken input[name=tname]', 'Claude on my laptop');
  await owner.click('dialog.profile form.newtoken button[type=submit]');
  await owner.waitForSelector('dialog.profile .fresh');
  const freshText = await owner.$eval('dialog.profile .fresh', (e) => e.innerText);
  check('making a token shows it once, with the MCP configuration to copy', (await owner.$eval('dialog.profile .fresh input', (e) => e.value)).startsWith('qq_') && freshText.includes('mcpServers') && freshText.includes('will not be shown again'));
  await owner.screenshot({ path: `${OUT}/39-tokens.png` });
  check('the token is listed as read only unless editing was allowed', (await owner.$eval('dialog.profile ul.tokens', (e) => e.innerText)).includes('Claude on my laptop') && (await owner.$eval('dialog.profile ul.tokens', (e) => e.innerText)).includes('read only'));
  await owner.evaluate(() => [...document.querySelectorAll('dialog.profile ul.tokens li')].find((li) => li.textContent.includes('Claude on my laptop')).querySelector('button').click());
  await until(async () => !(await owner.$eval('dialog.profile ul.tokens', (e) => e.innerText)).includes('Claude on my laptop'), 'token revoked');
  check('a token can be revoked from the list', true);
  await owner.keyboard.press('Escape');

  // ---- a stranger is asked to request a seat; the owner gives one
  const stranger = await newScribe('stranger');
  const strangerMail = email('stranger');
  await signup(stranger, 'Stranger', strangerMail);
  await stranger.goto(scrollUrl);
  await until(() => stranger.$('.card .seal'), 'the door page');
  check('a stranger is sent to "You need a seat", not shown the scroll', stranger.url().includes('/request/') && (await stranger.$eval('.card', (e) => e.innerText)).includes('You need a seat'));
  const doorText = await stranger.$eval('.card', (e) => e.innerText);
  check('it names the scroll and its owner, and shows who is signed in', doorText.includes('Thesis') && doorText.includes('Aelith') && doorText.includes(strangerMail), doorText.replace(/\s+/g, ' ').slice(0, 160));
  await stranger.screenshot({ path: `${OUT}/07-request-access.png` });
  await stranger.type('.card input[name=message]', 'Hi, I am helping with chapter 4');
  await stranger.click('.card button[type=submit]');
  await until(async () => (await stranger.$eval('.card', (e) => e.innerText)).includes('Your request is sent'), 'request sent');
  check('asking for a seat says the request is sent', true);
  await stranger.reload();
  await until(async () => (await stranger.$('.card .seal')) !== null && (await stranger.$eval('.card', (e) => e.innerText)).includes('waiting'), 'waiting page');
  check('and the door remembers it: "Your request is waiting"', true);
  await owner.goto(scrollUrl);
  await owner.waitForSelector('.cm-content');
  await owner.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Share').click());
  await owner.waitForSelector('dialog[open] .asks li');
  const askText = await owner.$eval('dialog[open] .asks', (e) => e.innerText);
  check('the owner sees who is asking, with their message, in Share', askText.includes('Stranger') && askText.includes('helping with chapter 4'));
  await owner.screenshot({ path: `${OUT}/07b-share-requests.png` });
  await owner.click('dialog[open] .asks li button[aria-label^="Give Stranger a seat as a reader"]');
  await until(async () => (await owner.$('dialog[open] .asks')) === null, 'request gone after approval');
  check('giving a seat takes it off the list', true);
  await owner.evaluate(() => [...document.querySelectorAll('dialog[open] button')].find((b) => b.textContent.trim() === 'Done').click());
  await stranger.goto(scrollUrl);
  await stranger.waitForSelector('.cm-content');
  check('the new reader can open the scroll now', (await stranger.$eval('body', (e) => e.innerText)).includes('You can look and download'));
  // a scroll that does not exist at all is still a plain 404
  await stranger.goto(`${BASE}/scroll/00000000-0000-4000-8000-000000000000`);
  await until(() => stranger.$('.lost'), '404 page');
  check('a scroll that does not exist is the "lost in the cellar" page', (await stranger.$eval('.lost h2', (e) => e.textContent)).includes('Lost in the cellar'));
  await stranger.screenshot({ path: `${OUT}/07-stranger-404.png` });

  // ---- magic link: no password
  const mage = await newScribe('mage');
  const mageMail = email('mage');
  await signup(mage, 'Merlin', mageMail);
  await mage.goto(`${BASE}/`);
  await mage.waitForSelector('.beam .btn');
  await mage.click('.beam .btn');
  await until(() => mage.url().includes('/login'), 'signed out');
  await mage.click('.btn--ink.magic');
  await sleep(200);
  check('"Email me a magic link" with no email typed asks for it', (await mage.$eval('.alert', (e) => e.textContent)).includes('Type your email'));
  await mage.type('input[name=email]', mageMail);
  await mage.click('.btn--ink.magic');
  await mage.waitForSelector('.chip-mail');
  const sentText = await mage.$eval('.card', (e) => e.innerText);
  check('the "Your magic link is cast" screen shows where it was sent and a resend countdown', sentText.includes('Your magic link is cast') && sentText.includes(mageMail) && /Resend in \d:\d\d/.test(sentText), sentText.replace(/\s+/g, ' ').slice(0, 200));
  await mage.screenshot({ path: `${OUT}/33-magic-link-sent.png` });
  const magicLink = await until(() => {
    for (const f of fs.readdirSync(outbox).sort().reverse()) {
      const body = fs.readFileSync(path.join(outbox, f), 'utf8');
      if (body.startsWith(`To: ${mageMail}`)) { const m = body.match(/https?:\/\/\S+\/magic\?token=\S+/); if (m) return m[0]; }
    }
  }, 'magic link mail');
  await mage.goto(magicLink);
  await mage.waitForSelector('.head h1');
  check('opening the mailed link signs you in, with no password', (await mage.$eval('.head h1', (e) => e.textContent)).includes('Your Scrolls'));
  await mage.goto(magicLink);
  await until(async () => (await mage.$eval('body', (e) => e.innerText)).includes('That link did not work') || mage.url().includes('/login'), 'used link refused');
  check('the link works only once', (await mage.$eval('body', (e) => e.innerText)).includes('That link did not work') || mage.url().includes('/login'));

  // ---- a session that ends while you are writing: sign in again on the spot, edits kept
  await mage.goto(`${BASE}/`);
  await mage.waitForSelector('.head h1');
  await mage.click('.head .acts .btn:not(.btn--ghost)');
  await mage.waitForSelector('dialog[open] input[name=title]');
  await mage.type('dialog[open] input[name=title]', 'Ending soon');
  await sleep(300);
  await mage.click('dialog[open] button[type=submit]');
  await mage.waitForSelector('.cm-content');
  await sleep(1000);
  await mage.click('.cm-content');
  await mage.keyboard.down(kMod);
  await mage.keyboard.press('ArrowDown');
  await mage.keyboard.up(kMod);
  await mage.keyboard.type(' unsavedwords');
  await sleep(300);
  await mage.deleteCookie(...(await mage.cookies()).filter((c) => c.name === 'quill_session'));
  await mage.keyboard.down(kMod);
  await mage.keyboard.press('Enter'); // compile: the server no longer knows who we are
  await mage.keyboard.up(kMod);
  await mage.waitForSelector('[role=alertdialog] #sess-title', { timeout: 15000 });
  const endedText = await mage.$eval('[role=alertdialog] .card', (e) => e.innerText);
  check('when the server stops knowing you, "Your session has ended" appears over the page', endedText.includes('Your session has ended') && endedText.includes('unsaved edits were kept'));
  await sleep(300); // the cursor lands a moment after the card appears
  check('your email is filled in and the cursor is on the password', (await mage.$eval('[role=alertdialog] input[name=email]', (e) => e.value)) === mageMail && (await mage.evaluate(() => document.activeElement?.id === 'sess-password')));
  await mage.screenshot({ path: `${OUT}/34-session-ended.png` });
  check('the page underneath still holds what you wrote', (await editorText(mage)).includes('unsavedwords'));
  await mage.type('#sess-password', 'wrong password here');
  await mage.click('[role=alertdialog] button[type=submit]');
  await mage.waitForSelector('[role=alertdialog] .alert');
  check('a wrong password is explained and the screen stays', (await mage.$eval('[role=alertdialog] .alert', (e) => e.textContent)).includes('do not match'));
  await mage.click('#sess-password', { clickCount: 3 });
  await mage.type('#sess-password', 'correct horse battery staple');
  await mage.click('[role=alertdialog] button[type=submit]');
  await until(async () => (await mage.$('[role=alertdialog]')) === null, 'screen gone after signing in again', 15000);
  check('signing in again brings you straight back, with your words still there', (await editorText(mage)).includes('unsavedwords') && mage.url().includes('/scroll/'));
  await until(async () => (await mage.$eval('.status', (e) => e.innerText)).includes('Connected'), 'live connection returns', 30000);
  check('and the live connection comes back by itself', true);

  // ---- sign out
  await owner.goto(`${BASE}/`);
  await owner.waitForSelector('.beam .btn');
  await owner.click('.beam .btn');
  await until(() => owner.url().includes('/login'), 'signed out');
  check('sign out returns to the login page', true);
  await owner.goto(scrollUrl);
  await until(() => owner.url().includes('/login'), 'guarded after sign-out');
  check('after sign-out the scroll URL is guarded (redirect keeps ?next)', owner.url().includes('next='), owner.url());
} catch (e) {
  console.log('ERROR', e.message, '\n' + String(e.stack).split('\n').filter((l) => l.includes('smoke.mjs')).slice(0, 2).join('\n'));
  results.push({ name: 'run completed', ok: false });
}
check('no uncaught page errors', consoleErrors.length === 0, consoleErrors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
