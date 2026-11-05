import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { AssetInfo } from '../latex/figure';

/** Images and PDFs of a scroll. The live list comes through Yjs; these calls change it. */
@Injectable({ providedIn: 'root' })
export class AssetsService {
  private readonly http = inject(HttpClient);

  /** URL of an asset's bytes (cookie-authenticated; `v` busts the cache when it is replaced). */
  url(scrollId: string, path: string, version?: string): string {
    const q = version ? `?v=${encodeURIComponent(version.slice(0, 12))}` : '';
    return `/api/scrolls/${scrollId}/assets/${path.split('/').map(encodeURIComponent).join('/')}${q}`;
  }

  list = (scrollId: string) => firstValueFrom(this.http.get<AssetInfo[]>(`/api/scrolls/${scrollId}/assets`));

  upload(scrollId: string, path: string, file: Blob): Promise<AssetInfo> {
    return firstValueFrom(this.http.put<AssetInfo>(this.url(scrollId, path), file, { headers: { 'Content-Type': 'application/octet-stream' } }));
  }

  /** Rename, move to another table, or (with `copy`) duplicate an asset, all on the server: the bytes never travel. */
  relocate = (scrollId: string, from: string, to: string, copy = false) => firstValueFrom(this.http.post<AssetInfo>(`/api/scrolls/${scrollId}/asset-moves`, { from, to, copy }));

  remove = (scrollId: string, path: string) => firstValueFrom(this.http.delete<void>(this.url(scrollId, path)));
}
