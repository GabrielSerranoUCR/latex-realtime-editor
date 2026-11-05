/** "0:42", "1:05": whole seconds as minutes and seconds (for the "Resend in …" line). */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
