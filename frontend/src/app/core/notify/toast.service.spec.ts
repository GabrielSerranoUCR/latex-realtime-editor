import { TestBed } from '@angular/core/testing';
import { ToastService } from './toast.service';

describe('ToastService', () => {
  it('carries an action button, and dismissing removes the toast', () => {
    const toasts = TestBed.inject(ToastService);
    let ran = 0;
    const id = toasts.show('Build failed.', 'bad', 10_000, { label: 'View ink log', run: () => ran++ });
    const t = toasts.toasts().find((x) => x.id === id)!;
    expect(t.action?.label).toBe('View ink log');
    t.action!.run();
    expect(ran).toBe(1);
    toasts.dismiss(id);
    expect(toasts.toasts().some((x) => x.id === id)).toBe(false);
  });
});
