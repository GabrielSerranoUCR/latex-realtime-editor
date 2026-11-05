import { Injectable, signal } from '@angular/core';

export type ProfileTab = 'profile' | 'security' | 'notifications';
export type SettingsTab = 'compiler' | 'editor' | 'collaboration';

/** Which of the two big dialogs is open (they are hosted once, at the root, so any page can open them). */
@Injectable({ providedIn: 'root' })
export class ModalsService {
  readonly profile = signal<ProfileTab | null>(null);
  readonly settings = signal<SettingsTab | null>(null);
  /** Set by the editor while a scroll is open: what this scribe may do there. Null on every other page. */
  readonly scrollContext = signal<{ canEdit: boolean } | null>(null);

  openProfile(tab: ProfileTab = 'profile'): void {
    this.profile.set(tab);
  }
  closeProfile(): void {
    this.profile.set(null);
  }
  openSettings(tab: SettingsTab = 'compiler'): void {
    this.settings.set(tab);
  }
  closeSettings(): void {
    this.settings.set(null);
  }
}
