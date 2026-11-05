import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * A 401 from the API for someone who was signed in means their session ended (it expired, or they were signed
 * out elsewhere). The "Your session has ended" screen then asks them to sign in again, right where they were.
 * The sign-in calls themselves are left alone: a wrong password is not a lost session.
 */
export const sessionInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  return next(req).pipe(
    tap({
      error: (e: unknown) => {
        if (e instanceof HttpErrorResponse && e.status === 401 && req.url.startsWith('/api/') && !req.url.startsWith('/api/auth/')) auth.markSessionEnded();
      },
    }),
  );
};
