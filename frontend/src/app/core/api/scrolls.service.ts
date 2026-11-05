import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type Role = 'owner' | 'scribe' | 'reader';

export interface ScrollSummary {
  id: string;
  title: string;
  role: Role;
  ownerName: string;
  memberCount: number;
  updatedAt: string;
  /** How an AI assistant's edits arrive: a person accepts each, or they apply at once (the owner's choice). */
  aiEditMode?: AiEditMode;
}

export type AiEditMode = 'review' | 'auto';

export interface Member {
  userId: string;
  displayName: string;
  email: string;
  color: string;
  role: Role;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: Exclude<Role, 'owner'>;
  expiresAt: string;
}

export interface MyInvite {
  id: string;
  scrollId: string;
  scrollTitle: string;
  inviterName: string;
  role: Exclude<Role, 'owner'>;
  expiresAt: string;
}

export const canWrite = (role: Role | null | undefined): boolean => role === 'owner' || role === 'scribe';

@Injectable({ providedIn: 'root' })
export class ScrollsService {
  private readonly http = inject(HttpClient);

  list = () => firstValueFrom(this.http.get<ScrollSummary[]>('/api/scrolls'));
  get = (id: string) => firstValueFrom(this.http.get<ScrollSummary>(`/api/scrolls/${id}`));
  create = (title: string) => firstValueFrom(this.http.post<ScrollSummary>('/api/scrolls', { title }));
  rename = (id: string, title: string) => firstValueFrom(this.http.patch<void>(`/api/scrolls/${id}`, { title }));
  remove = (id: string) => firstValueFrom(this.http.delete<void>(`/api/scrolls/${id}`));

  members = (id: string) => firstValueFrom(this.http.get<Member[]>(`/api/scrolls/${id}/members`));
  invite = (id: string, email: string, role: Exclude<Role, 'owner'>) => firstValueFrom(this.http.post<PendingInvite>(`/api/scrolls/${id}/invitations`, { email, role }));
  pendingInvites = (id: string) => firstValueFrom(this.http.get<PendingInvite[]>(`/api/scrolls/${id}/invitations`));
  revokeInvite = (id: string, inviteId: string) => firstValueFrom(this.http.delete<void>(`/api/scrolls/${id}/invitations/${inviteId}`));

  myInvites = () => firstValueFrom(this.http.get<MyInvite[]>('/api/invitations'));
  getInvite = (inviteId: string) => firstValueFrom(this.http.get<MyInvite>(`/api/invitations/${inviteId}`));
  acceptInvite = (inviteId: string) => firstValueFrom(this.http.post<{ scrollId: string; role: Role }>(`/api/invitations/${inviteId}/accept`, {}));
  declineInvite = (inviteId: string) => firstValueFrom(this.http.delete<void>(`/api/invitations/${inviteId}`));
  // an AI assistant's edits: held for review, or applied at once (only the owner may choose that)
  setAiMode = (id: string, mode: AiEditMode) => firstValueFrom(this.http.put<void>(`/api/scrolls/${id}/ai-mode`, { mode }));
  proposals = (id: string) => firstValueFrom(this.http.get<EditProposal[]>(`/api/scrolls/${id}/proposals`));
  acceptProposal = (id: string, pid: string) => firstValueFrom(this.http.post<void>(`/api/scrolls/${id}/proposals/${pid}/accept`, {}));
  rejectProposal = (id: string, pid: string) => firstValueFrom(this.http.post<void>(`/api/scrolls/${id}/proposals/${pid}/reject`, {}));
  // asking for a seat: the "You need a seat" page, and the owner's list in Share
  door = (id: string) => firstValueFrom(this.http.get<Door>(`/api/scrolls/${id}/door`));
  askForSeat = (id: string, message: string) => firstValueFrom(this.http.post<void>(`/api/scrolls/${id}/requests`, { message }));
  seatRequests = (id: string) => firstValueFrom(this.http.get<SeatRequest[]>(`/api/scrolls/${id}/requests`));
  approveRequest = (id: string, userId: string, role: 'scribe' | 'reader') => firstValueFrom(this.http.post<void>(`/api/scrolls/${id}/requests/${userId}/approve`, { role }));
  declineRequest = (id: string, userId: string) => firstValueFrom(this.http.delete<void>(`/api/scrolls/${id}/requests/${userId}`));
  // share links: one for editing (scribe), one for viewing (reader)
  shareLinks = (id: string) => firstValueFrom(this.http.get<ShareLink[]>(`/api/scrolls/${id}/links`));
  putShareLink = (id: string, role: 'scribe' | 'reader') => firstValueFrom(this.http.put<ShareLink>(`/api/scrolls/${id}/links/${role}`, {}));
  removeShareLink = (id: string, role: 'scribe' | 'reader') => firstValueFrom(this.http.delete<void>(`/api/scrolls/${id}/links/${role}`));
  linkPreview = (token: string) => firstValueFrom(this.http.get<LinkPreview>(`/api/links/${encodeURIComponent(token)}`));
  joinByLink = (token: string) => firstValueFrom(this.http.post<{ scrollId: string; role: Role }>(`/api/links/${encodeURIComponent(token)}/join`, {}));
  setRole = (id: string, userId: string, role: Exclude<Role, 'owner'>) => firstValueFrom(this.http.put<void>(`/api/scrolls/${id}/members/${userId}`, { role }));
  removeMember = (id: string, userId: string) => firstValueFrom(this.http.delete<void>(`/api/scrolls/${id}/members/${userId}`));
}

/** "2 hours ago" for the dashboard cards. */
export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  const units: Array<[number, string]> = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [604800, 'week'], [2629800, 'month'], [31557600, 'year']];
  let chosen: [number, string] = [1, 'second'];
  for (const u of units) if (s >= u[0]) chosen = u;
  const n = Math.floor(s / chosen[0]);
  return `${n} ${chosen[1]}${n === 1 ? '' : 's'} ago`;
}

export interface ShareLink {
  role: 'scribe' | 'reader';
  token: string;
}
export interface LinkPreview {
  scrollId: string;
  scrollTitle: string;
  ownerName: string;
  role: 'scribe' | 'reader';
}

/** The address a share link opens at. */
export function shareUrl(origin: string, token: string): string {
  return `${origin}/join/${token}`;
}

/** What a signed-in stranger may know about a private scroll: its name and who owns it. */
export interface Door {
  title: string;
  ownerName: string;
  member: boolean;
  requested: boolean;
}
export interface SeatRequest {
  userId: string;
  displayName: string;
  email: string;
  message: string;
  createdAt: string;
}

/** An edit an assistant proposed, waiting for a person to accept or reject it. */
export interface EditProposal {
  id: string;
  kind: 'write' | 'edit' | 'delete';
  path: string;
  oldText: string | null;
  newText: string | null;
  replaceAll: boolean;
  /** For a whole-file write: the new text (long ones cut short). */
  content: string | null;
  note: string;
  tokenName: string;
  by: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
}
