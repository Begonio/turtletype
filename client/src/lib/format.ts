/** "2 min", "1h 20m", "3h" — short enough for a slider label. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';

  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return 'under a minute';
  if (totalMinutes < 60) return `${totalMinutes} min`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}

/** Clock time a job started now would finish at. */
export function formatFinishTime(ms: number): string {
  const end = new Date(Date.now() + ms);
  const sameDay = end.toDateString() === new Date().toDateString();
  const time = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${time} on ${end.toLocaleDateString(undefined, { weekday: 'short' })}`;
}

/**
 * Maps a 0–1 slider position onto a duration range logarithmically.
 *
 * The usable range spans minutes to a full day, so a linear slider would spend
 * most of its travel in territory nobody wants. Log spacing keeps the short
 * end — where the interesting choices are — controllable.
 */
export function sliderToDuration(position: number, min: number, max: number): number {
  if (max <= min) return min;
  const clamped = Math.min(1, Math.max(0, position));
  return Math.round(min * (max / min) ** clamped);
}

export function durationToSlider(duration: number, min: number, max: number): number {
  if (max <= min || duration <= min) return 0;
  return Math.min(1, Math.log(duration / min) / Math.log(max / min));
}
