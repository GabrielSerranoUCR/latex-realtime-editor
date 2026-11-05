import { Injectable } from '@angular/core';

/** A .zip chosen on the quest board, waiting to be unpacked into the brand-new scroll it was made for. */
@Injectable({ providedIn: 'root' })
export class PendingImportService {
  private pending: { scrollId: string; file: File } | null = null;

  hold(scrollId: string, file: File): void {
    this.pending = { scrollId, file };
  }

  /** True while an import is waiting for this scroll (the starter file must not be written over it). */
  has(scrollId: string | null): boolean {
    return !!scrollId && this.pending?.scrollId === scrollId;
  }

  /** Hands the file over exactly once. */
  take(scrollId: string): File | null {
    if (!this.has(scrollId)) return null;
    const file = this.pending!.file;
    this.pending = null;
    return file;
  }
}

/** A scroll title from an archive name: “thesis-final.zip” becomes “thesis final”. */
export function titleFromZip(name: string): string {
  const base = name.replace(/\.zip$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (base || 'Imported scroll').slice(0, 120);
}
