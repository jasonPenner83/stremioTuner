# Schedule Generation Error Visibility — Design Spec

## Summary

When schedule generation fails for a channel (e.g. an upstream addon returns
HTML instead of JSON, or the addon can't be resolved), the only trace today
is a `console.error` line in the container logs — the admin UI and the
channel itself give no indication anything is wrong, so a broken channel
just silently 404s forever when someone tries to play it. This spec adds a
per-channel `lastError` surfaced in the admin UI's "My channels" table.

## Problem

Diagnosing a broken channel currently requires pulling container logs and
matching a channel name against a `console.error` line. There's no
in-app signal that a channel's schedule generation is failing.

## Goals

- Track the most recent schedule-generation failure (or resolved-addon
  failure) per live channel, in memory.
- Clear it automatically on the next successful generation.
- Surface it in the "My channels" table as a "Status" column.

## Non-goals

- No persistence of the error across a restart — `bootstrap.js` already
  re-runs generation for stale schedules at startup, so the error state
  re-populates within moments if the underlying problem is still present;
  persisting it would add a file-write path for no real benefit.
- No notifications/alerts (email, push, etc.) — visible in the admin UI is
  sufficient for this pass.
- No retry-backoff changes — generation already retries daily (and at
  startup for stale schedules); this spec only makes existing failures
  visible, not more frequent or smarter.

## `bootstrap.js` changes

`regenerate(channel)` gains error tracking on both of its existing failure
paths, and clears the error on success:

```js
async function regenerate(channel) {
  if (!channel.source) {
    channel.lastError = 'No resolved addon source';
    console.error(`Skipping schedule regeneration for "${channel.name}": no resolved addon source`);
    return;
  }
  try {
    const schedule = await generateChannelScheduleImpl({ channel, source: channel.source });
    await writeScheduleImpl(dataDir, channel.id, schedule);
    channel.lastError = null;
  } catch (err) {
    channel.lastError = err.message;
    console.error(`Schedule generation failed for "${channel.name}": ${err.message}`);
  }
}
```

`channel.lastError` is `undefined` until the first `regenerate()` call
completes (neither `true` nor a message) — the UI treats `undefined`,
`null`, and absent the same way ("OK"/no status shown).

## `channelActions.listChannels()` change

`listChannels()` already reads the persisted channel list; it now merges in
each channel's live `lastError` (looking the channel up in the `channels`
array already in its closure — the same array `addChannel`/`updateChannel`
already mutate):

```js
async function listChannels() {
  const persisted = await readChannelsImpl(dataDir);
  return persisted.map((ch) => {
    const live = channels.find((c) => c.id === ch.id);
    return { ...ch, lastError: live?.lastError ?? null };
  });
}
```

A disabled channel (not in the live array) always gets `lastError: null` —
there's nothing to report since it isn't being generated at all. This is
purely additive to the existing `GET /admin/channels` response shape — no
route changes needed.

## Admin UI

A new "Status" column in the "My channels" table, after "Enabled" and
before "Delete":

- `ch.lastError` falsy → cell shows `OK`.
- `ch.lastError` truthy → cell shows the error text, styled to stand out
  (reusing the existing banner's red color as an inline style or a small
  CSS class), with the full message available via a `title` attribute
  (tooltip) in case it's long — the visible text can be the same string,
  since these error messages are normally short one-liners.

No new admin API endpoint — this rides on the existing `GET
/admin/channels` polling that already happens every time the "My channels"
table (re)loads.

## Error handling

- N/A beyond what's described above — this feature only surfaces existing
  error states, it doesn't introduce new failure modes.

## Testing

- `bootstrap.js`: extend existing regeneration tests to confirm
  `channel.lastError` is set to the thrown error's message on a
  generation failure, set to `'No resolved addon source'` when `source` is
  null, and cleared back to `null` after a subsequent successful
  regeneration.
- `channelActions.js`: extend `listChannels` tests to confirm a live
  channel's `lastError` is merged in, and a channel not present in the live
  array (e.g. disabled) gets `lastError: null`.
- Admin UI: manual verification only, per this project's existing
  convention for the static admin page.
