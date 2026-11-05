import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface VersionInfo {
  id: string;
  label: string | null;
  /** Taken automatically (and pruned eventually) unless it has been named. */
  auto: boolean;
  createdAt: string;
  authorId: string | null;
  authorName: string | null;
}

export interface VersionDetail extends VersionInfo {
  /** The text files as they were. */
  files: Record<string, string>;
}

/** A version you are looking at: its text files, ready to compare with the live ones. */
export interface ViewedVersion {
  info: VersionInfo;
  files: ReadonlyMap<string, string>;
}

@Injectable({ providedIn: 'root' })
export class VersionsService {
  private readonly http = inject(HttpClient);
  private url = (scrollId: string, tail = '') => `/api/scrolls/${scrollId}/versions${tail}`;

  list = (scrollId: string) => firstValueFrom(this.http.get<VersionInfo[]>(this.url(scrollId)));
  get = (scrollId: string, id: string) => firstValueFrom(this.http.get<VersionDetail>(this.url(scrollId, `/${id}`)));
  /** Name the present state. */
  create = (scrollId: string, label: string) => firstValueFrom(this.http.post<VersionInfo>(this.url(scrollId), { label }));
  /** Name an existing snapshot (which also keeps it). */
  rename = (scrollId: string, id: string, label: string) => firstValueFrom(this.http.patch<VersionInfo>(this.url(scrollId, `/${id}`), { label }));
  /** Rewrites the live document; the present is saved as its own version first. */
  restore = (scrollId: string, id: string) => firstValueFrom(this.http.post<void>(this.url(scrollId, `/${id}/restore`), {}));
}
