import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth/auth.guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', canActivate: [authGuard], loadComponent: () => import('./features/dashboard/dashboard.page').then((m) => m.DashboardPage) },
  { path: 'login', canActivate: [guestGuard], data: { mode: 'login' }, loadComponent: () => import('./features/auth/auth.page').then((m) => m.AuthPage) },
  { path: 'signup', canActivate: [guestGuard], data: { mode: 'signup' }, loadComponent: () => import('./features/auth/auth.page').then((m) => m.AuthPage) },
  { path: 'forgot-password', canActivate: [guestGuard], data: { mode: 'forgot' }, loadComponent: () => import('./features/account/account.page').then((m) => m.AccountPage) },
  { path: 'magic-sent', canActivate: [guestGuard], data: { mode: 'magic-sent' }, loadComponent: () => import('./features/account/account.page').then((m) => m.AccountPage) },
  { path: 'magic', data: { mode: 'magic' }, loadComponent: () => import('./features/account/account.page').then((m) => m.AccountPage) },
  { path: 'reset-password', data: { mode: 'reset' }, loadComponent: () => import('./features/account/account.page').then((m) => m.AccountPage) },
  { path: 'verify-email', data: { mode: 'verify' }, loadComponent: () => import('./features/account/account.page').then((m) => m.AccountPage) },
  { path: 'invitations/:id', canActivate: [authGuard], loadComponent: () => import('./features/account/invitation.page').then((m) => m.InvitationPage) },
  { path: 'request/:id', canActivate: [authGuard], loadComponent: () => import('./features/account/request-access.page').then((m) => m.RequestAccessPage) },
  { path: 'join/:token', canActivate: [authGuard], loadComponent: () => import('./features/account/join.page').then((m) => m.JoinPage) },
  { path: 'scroll/:id/popout/:panel', canActivate: [authGuard], loadComponent: () => import('./features/popout/popout.page').then((m) => m.PopoutPage) },
  { path: 'scroll/:id/hall', canActivate: [authGuard], loadComponent: () => import('./features/hall/hall.page').then((m) => m.HallPage) },
  { path: 'scroll/:id', canActivate: [authGuard], loadComponent: () => import('./features/editor/editor.page').then((m) => m.EditorPage) },
  { path: '**', loadComponent: () => import('./features/not-found/not-found.page').then((m) => m.NotFoundPage) },
];
