import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface User {
  id: string;
  email: string;
  displayName: string;
  color: string;
  emailVerified: boolean;
  /** A line about who this scribe writes for; may be empty. */
  affiliation: string;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  expiresAt: string;
  /** The browser that started it, as it described itself (may be empty). */
  userAgent: string;
  current: boolean;
}

/** Turns an API failure into a sentence for the UI (the server already writes friendly ones). */
export function apiMessage(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const err = e as HttpErrorResponse;
  if (err?.status === 0) return 'The tavern is unreachable. Check your connection and try again.';
  return err?.error?.error ?? fallback;
}

/** Who is signed in. The session itself lives in an HttpOnly cookie the page never sees. */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  readonly user = signal<User | null>(null);
  /** False until the first `/api/me` answer, so guards do not flash the login page on reload. */
  readonly ready = signal(false);
  readonly signedIn = computed(() => this.user() !== null);
  /**
   * Set when the server stops accepting the session of someone who was signed in (the cookie expired, or the
   * session was ended elsewhere). Holds their email. The page stays where it is, with its unsaved work, and
   * the "Your session has ended" screen asks them to sign in again on top of it.
   */
  readonly endedFor = signal<string | null>(null);

  /** Ask the server who we are. Safe to call repeatedly (e.g. to detect an expired session). */
  async refresh(): Promise<User | null> {
    try {
      this.user.set(await firstValueFrom(this.http.get<User>('/api/me')));
    } catch {
      this.user.set(null);
    }
    this.ready.set(true);
    return this.user();
  }

  /** The server said "who are you?" to someone we thought was signed in. */
  markSessionEnded(): void {
    const u = this.user();
    if (u && !this.endedFor()) this.endedFor.set(u.email);
  }

  /**
   * Is the session still good? A refusal marks it ended (the user stays set, so the page behind the
   * "session ended" screen keeps its name and colours). A network failure proves nothing: counts as still good.
   */
  async checkSession(): Promise<boolean> {
    try {
      this.user.set(await firstValueFrom(this.http.get<User>('/api/me')));
      return true;
    } catch (e) {
      if ((e as HttpErrorResponse)?.status === 401) {
        this.markSessionEnded();
        return false;
      }
      return true;
    }
  }

  /** The "session ended" screen asks now and then whether you have signed in again elsewhere (another tab, a magic link). */
  async recoverSession(): Promise<boolean> {
    try {
      this.user.set(await firstValueFrom(this.http.get<User>('/api/me')));
      this.endedFor.set(null);
      return true;
    } catch {
      return false;
    }
  }

  /** Sign in again from the "session ended" screen. */
  async signInAgain(email: string, password: string): Promise<void> {
    await this.login(email, password);
    this.endedFor.set(null);
  }

  /** Email a one-time sign-in link. Always succeeds from the caller's view (the server never says who has an account). */
  requestMagicLink = (email: string) => firstValueFrom(this.http.post<void>('/api/auth/magic', { email }));

  /** Trade the token from a magic link for a session. */
  async useMagicLink(token: string): Promise<void> {
    this.user.set(await firstValueFrom(this.http.post<User>('/api/auth/magic/consume', { token })));
    this.ready.set(true);
    this.endedFor.set(null);
  }

  async login(email: string, password: string): Promise<void> {
    this.user.set(await firstValueFrom(this.http.post<User>('/api/auth/login', { email, password })));
    this.ready.set(true);
  }

  async signup(email: string, displayName: string, password: string): Promise<void> {
    this.user.set(await firstValueFrom(this.http.post<User>('/api/auth/signup', { email, displayName, password })));
    this.ready.set(true);
  }

  /** Always succeeds from the caller's view (the server never reveals whether an account exists). */
  forgotPassword = (email: string) => firstValueFrom(this.http.post<void>('/api/auth/forgot', { email }));
  resetPassword = (token: string, password: string) => firstValueFrom(this.http.post<void>('/api/auth/reset', { token, password }));
  verifyEmail = (token: string) => firstValueFrom(this.http.post<void>('/api/auth/verify', { token }));
  resendVerification = () => firstValueFrom(this.http.post<void>('/api/auth/resend-verification', {}));

  async updateProfile(patch: { displayName?: string; color?: string; affiliation?: string }): Promise<void> {
    this.user.set(await firstValueFrom(this.http.patch<User>('/api/me', patch)));
  }
  changePassword = (currentPassword: string, newPassword: string) => firstValueFrom(this.http.post<void>('/api/me/password', { currentPassword, newPassword }));
  sessions = () => firstValueFrom(this.http.get<SessionInfo[]>('/api/me/sessions'));
  revokeSession = (id: string) => firstValueFrom(this.http.delete<void>(`/api/me/sessions/${id}`));
  async deleteAccount(password: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>('/api/me', { body: { password } }));
    this.user.set(null);
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/auth/logout', {}));
    } finally {
      this.user.set(null);
      this.endedFor.set(null);
    }
  }
}
