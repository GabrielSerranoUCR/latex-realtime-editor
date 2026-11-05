import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { AssetInfo } from '../../../core/latex/figure';
import { FileTreeComponent } from './file-tree.component';

// the test DOM has no modal dialogs: give it a simple open/close
const proto = HTMLDialogElement.prototype as any;
proto.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
proto.close ??= function (this: HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };

const asset: AssetInfo = { path: 'figures/orbit.png', size: 2048, mime: 'image/png', sha256: 'a'.repeat(64) };

function setup(canEdit = true) {
  const fixture = TestBed.createComponent(FileTreeComponent);
  fixture.componentRef.setInput('files', ['main.tex']);
  fixture.componentRef.setInput('assets', [asset]);
  fixture.componentRef.setInput('canEdit', canEdit);
  fixture.componentRef.setInput('active', 'figures/orbit.png'); // unfolds its folder
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  return { fixture, host, c: fixture.componentInstance as any };
}

const dropEvent = (type: string, files: File[]) => {
  const e = new Event(type, { bubbles: true, cancelable: true }) as any;
  e.dataTransfer = { types: ['Files'], files };
  return e;
};

describe('FileTreeComponent assets', () => {
  it('seats assets in their table beside the sources', () => {
    const { host } = setup();
    const names = Array.from(host.querySelectorAll('li.file .nm')).map((n) => n.textContent);
    expect(names).toEqual(['orbit.png', 'main.tex']);
    expect(host.querySelector('li.asset .size')?.textContent).toContain('2.0 KB');
  });

  it('routes clicks and removal by kind', () => {
    const { host, c } = setup();
    const seen: string[] = [];
    c.select.subscribe((p: string) => seen.push('text:' + p));
    c.selectAsset.subscribe((p: string) => seen.push('asset:' + p));
    c.removeAsset.subscribe((p: string) => seen.push('rm-asset:' + p));
    const [orbit, main] = Array.from(host.querySelectorAll<HTMLElement>('li.file'));
    orbit.click();
    main.click();
    orbit.querySelector<HTMLElement>('.del')!.click();
    expect(seen).toEqual(['asset:figures/orbit.png', 'text:main.tex']); // nothing is removed until the scribe says yes
    host.querySelector('dialog form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(seen).toEqual(['asset:figures/orbit.png', 'text:main.tex', 'rm-asset:figures/orbit.png']);
  });

  it('warns before removing, names the file, and "Keep it" removes nothing', () => {
    const { fixture, host, c } = setup();
    const removed: string[] = [];
    c.remove.subscribe((p: string) => removed.push(p));
    c.removeAsset.subscribe((p: string) => removed.push(p));
    fixture.componentRef.setInput('files', ['main.tex', 'extra.tex']);
    fixture.componentRef.setInput('main', 'main.tex');
    fixture.detectChanges();
    const extra = Array.from(host.querySelectorAll<HTMLElement>('li.file')).find((l) => l.textContent!.includes('extra.tex'))!;
    extra.querySelector<HTMLElement>('.del')!.click();
    fixture.detectChanges();
    const dlg = host.querySelector('dialog') as HTMLDialogElement;
    expect(dlg.open).toBe(true);
    expect(dlg.querySelector('h2')!.textContent).toContain('extra.tex');
    expect(dlg.textContent).toContain('version history');
    (dlg.querySelector('.btn--ink') as HTMLElement).click();
    expect(dlg.open).toBe(false);
    expect(removed).toEqual([]);
    extra.querySelector<HTMLElement>('.del')!.click();
    dlg.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(removed).toEqual(['extra.tex']);
  });

  it('emits dropped files and clears the drop state', () => {
    const { fixture, host, c } = setup();
    const got: File[][] = [];
    c.upload.subscribe((f: File[]) => got.push(f));
    const file = new File(['x'], 'a.png');
    host.dispatchEvent(dropEvent('dragover', []));
    fixture.detectChanges();
    expect(host.classList.contains('dragging')).toBe(true);
    host.dispatchEvent(dropEvent('drop', [file]));
    fixture.detectChanges();
    expect(got).toEqual([[file]]);
    expect(host.classList.contains('dragging')).toBe(false);
  });

  it('readers cannot upload or delete', () => {
    const { host, c } = setup(false);
    const got: File[][] = [];
    c.upload.subscribe((f: File[]) => got.push(f));
    host.dispatchEvent(dropEvent('drop', [new File(['x'], 'a.png')]));
    expect(got).toEqual([]);
    expect(host.querySelector('.del')).toBeNull();
    expect(host.querySelector('button[aria-label="New file"]')).toBeNull();
  });
});

describe('FileTreeComponent folders', () => {
  function folderSetup(over: { files?: string[]; folders?: string[]; canEdit?: boolean } = {}) {
    const fixture = TestBed.createComponent(FileTreeComponent);
    fixture.componentRef.setInput('files', over.files ?? ['main.tex', 'chapters/intro.tex']);
    fixture.componentRef.setInput('folders', over.folders ?? []);
    fixture.componentRef.setInput('canEdit', over.canEdit ?? true);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const created: string[] = [];
    const removed: string[] = [];
    const files: string[] = [];
    fixture.componentInstance.createFolder.subscribe((p) => created.push(p));
    fixture.componentInstance.removeFolder.subscribe((p) => removed.push(p));
    fixture.componentInstance.create.subscribe((p) => files.push(p));
    const click = (el: Element | null) => {
      (el as HTMLElement).click();
      fixture.detectChanges();
    };
    const type = (sel: string, value: string) => {
      const el = host.querySelector(sel) as HTMLInputElement;
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
    };
    const submit = () => {
      (host.querySelector('form.folder') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      fixture.detectChanges();
    };
    return { fixture, host, created, removed, files, click, type, submit };
  }

  it('offers New file and New folder side by side, to writers only', () => {
    const t = folderSetup();
    expect(Array.from(t.host.querySelectorAll('.actions button')).map((b) => b.getAttribute('aria-label'))).toEqual(['New file', 'New folder']);
    expect(folderSetup({ canEdit: false }).host.querySelector('.actions')).toBeNull();
  });

  it('shows an empty folder, and lets you remove it (only when it is empty)', () => {
    const t = folderSetup({ folders: ['drafts'] });
    const dirs = Array.from(t.host.querySelectorAll('li.dir')).map((d) => d.textContent!.replace(/\s+/g, ' ').trim());
    expect(dirs.some((d) => d.includes('drafts'))).toBe(true);
    expect(t.host.querySelector('button[aria-label="Remove empty folder drafts"]')).not.toBeNull();
    expect(t.host.querySelector('button[aria-label="Remove empty folder chapters"]')).toBeNull();
    t.click(t.host.querySelector('button[aria-label="Remove empty folder drafts"]'));
    expect(t.removed).toEqual(['drafts']);
  });

  it('creates a folder at the top level', () => {
    const t = folderSetup();
    t.click(t.host.querySelector('button[aria-label="New folder"]'));
    expect(t.host.querySelector('form.folder')).not.toBeNull();
    t.type('input[name=folder]', '  appendix ');
    t.submit();
    expect(t.created).toEqual(['appendix']);
    expect(t.host.querySelector('form.folder')).toBeNull();
  });

  it('creates a folder inside another one', () => {
    const t = folderSetup();
    t.click(t.host.querySelector('button[aria-label="New folder"]'));
    const select = t.host.querySelector('form.folder select') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent!.trim())).toEqual(['The main hall (top level)', 'chapters/']);
    select.value = 'chapters';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    t.fixture.detectChanges();
    t.type('input[name=folder]', 'old');
    t.submit();
    expect(t.created).toEqual(['chapters/old']);
  });

  it('explains a bad or taken name and creates nothing', () => {
    const t = folderSetup({ folders: ['drafts'] });
    t.click(t.host.querySelector('button[aria-label="New folder"]'));
    t.type('input[name=folder]', '');
    t.submit();
    expect(t.host.querySelector('form.folder .err')!.textContent).toContain('Give the table a name');
    t.type('input[name=folder]', 'bad name!');
    t.submit();
    expect(t.host.querySelector('form.folder .err')!.textContent).toContain('letters, numbers');
    t.type('input[name=folder]', 'drafts');
    t.submit();
    expect(t.host.querySelector('form.folder .err')!.textContent).toContain('already exists');
    expect(t.created).toEqual([]);
    t.type('input[name=folder]', 'fresh'); // typing clears the message
    expect(t.host.querySelector('form.folder .err')).toBeNull();
  });

  it('the plus beside a folder starts a new file already inside it', () => {
    const t = folderSetup({ folders: ['drafts'] });
    t.click(t.host.querySelector('button[aria-label="New file in drafts"]'));
    const locked = t.host.querySelector('form.add input.locked') as HTMLInputElement;
    expect(locked.value).toBe('drafts/');
    expect(locked.disabled).toBe(true);
    const input = t.host.querySelector('form.add input[aria-label="New file name"]') as HTMLInputElement;
    expect(input.value).toBe('');
    input.value = 'idea.tex';
    (t.host.querySelector('form.add') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(t.files).toEqual(['drafts/idea.tex']);
  });

  it('opening one form closes the other', () => {
    const t = folderSetup();
    t.click(t.host.querySelector('button[aria-label="New file"]'));
    expect(t.host.querySelector('form.add:not(.folder)')).not.toBeNull();
    t.click(t.host.querySelector('button[aria-label="New folder"]'));
    expect(t.host.querySelector('form.add:not(.folder)')).toBeNull();
    expect(t.host.querySelector('form.folder')).not.toBeNull();
  });
});

describe('FileTreeComponent folding', () => {
  function tree() {
    const fixture = TestBed.createComponent(FileTreeComponent);
    fixture.componentRef.setInput('files', ['main.tex', 'chapters/intro.tex', 'chapters/deep/more.tex']);
    fixture.componentRef.setInput('assets', []);
    fixture.componentRef.setInput('canEdit', true);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const names = () => Array.from(host.querySelectorAll('li .nm')).map((n) => n.textContent!.replace(/[▸▾]/g, '').trim());
    const dir = (name: string) => Array.from(host.querySelectorAll<HTMLElement>('li.dir')).find((d) => d.textContent!.includes(name))!;
    return { fixture, host, names, dir };
  }

  it('starts folded, and a click unfolds a folder and folds it again', () => {
    const { fixture, names, dir } = tree();
    expect(names()).toEqual(['chapters', 'main.tex']);
    expect(dir('chapters').getAttribute('aria-expanded')).toBe('false');
    expect(dir('chapters').textContent).toContain('▸');
    dir('chapters').click();
    fixture.detectChanges();
    expect(names()).toContain('intro.tex');
    expect(dir('chapters').getAttribute('aria-expanded')).toBe('true');
    dir('chapters').click();
    fixture.detectChanges();
    expect(names()).toEqual(['chapters', 'main.tex']);
  });

  it('folds with the keyboard, and the buttons inside a folder row do not fold it', () => {
    const { fixture, names, dir, host } = tree();
    dir('chapters').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(names()).toContain('intro.tex');
    dir('chapters').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    expect(names()).not.toContain('intro.tex');
    dir('chapters').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    fixture.detectChanges();
    host.querySelector<HTMLElement>('li.dir .dirbtn')!.click();
    fixture.detectChanges();
    expect(names()).toContain('intro.tex'); // the plus did not fold it
  });

  it('opens the folders of the file that becomes the active one', () => {
    const { fixture, names } = tree();
    expect(names()).not.toContain('more.tex');
    fixture.componentRef.setInput('active', 'chapters/deep/more.tex');
    fixture.detectChanges();
    expect(names()).toContain('more.tex');
  });
});
