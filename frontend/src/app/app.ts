import { Component, inject } from '@angular/core';
import { PreferencesService } from './core/prefs/prefs.service';
import { RouterOutlet } from '@angular/router';
import { ProfileModalComponent } from './features/account/profile-modal.component';
import { SettingsModalComponent } from './features/account/settings-modal.component';
import { SessionEndedComponent } from './features/account/session-ended.component';
import { ToastsComponent } from './shared/toasts.component';

@Component({
  selector: 'app-root',
  imports: [SessionEndedComponent, RouterOutlet, ProfileModalComponent, SettingsModalComponent, ToastsComponent],
  template: '<router-outlet /><qq-profile-modal /><qq-settings-modal /><qq-toasts /><qq-session-ended />',
})
export class App {
  /** Created at start so the saved theme is on the page before the first screen. */
  protected readonly prefs = inject(PreferencesService);
}
