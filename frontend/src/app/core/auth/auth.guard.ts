import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/** Only signed-in scribes may enter; others are sent to the door and brought back afterwards. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.ready()) await auth.refresh();
  return auth.signedIn() ? true : router.createUrlTree(['/login'], { queryParams: { next: state.url } });
};

/** Login/signup are pointless when already signed in. */
export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.ready()) await auth.refresh();
  return auth.signedIn() ? router.createUrlTree(['/']) : true;
};

/** Only follow same-site relative redirects (never `//evil.example` or absolute URLs). */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : '/';
}
