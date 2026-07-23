export function mostRecentBoundary(refreshTime, now) {
  const [hh, mm] = refreshTime.split(':').map(Number);
  const boundary = new Date(now);
  boundary.setHours(hh, mm, 0, 0);
  if (boundary.getTime() > now.getTime()) {
    boundary.setDate(boundary.getDate() - 1);
  }
  return boundary;
}

export function nextBoundary(refreshTime, now) {
  const [hh, mm] = refreshTime.split(':').map(Number);
  const boundary = new Date(now);
  boundary.setHours(hh, mm, 0, 0);
  if (boundary.getTime() <= now.getTime()) {
    boundary.setDate(boundary.getDate() + 1);
  }
  return boundary;
}

export function msUntilNextRun(refreshTime, now) {
  return nextBoundary(refreshTime, now).getTime() - now.getTime();
}

export function scheduleDailyAt(refreshTime, callback, {
  now = () => new Date(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout
} = {}) {
  let cancelled = false;
  let timer = null;

  function scheduleNext() {
    if (cancelled) return;
    const delay = msUntilNextRun(refreshTime, now());
    timer = setTimeoutImpl(() => {
      callback();
      scheduleNext();
    }, delay);
  }

  scheduleNext();

  return {
    cancel() {
      cancelled = true;
      if (timer !== null) clearTimeoutImpl(timer);
    }
  };
}
