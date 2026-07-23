import { describe, expect, it } from 'vitest';
import {
  StaleTaskError,
  createLatestTaskTracker,
} from './latestTask';

describe('latest task tracker', () => {
  it('makes an older task stale when a newer task begins', () => {
    const tracker = createLatestTaskTracker();
    const first = tracker.begin();
    const second = tracker.begin();

    expect(tracker.isCurrent(first)).toBe(false);
    expect(tracker.isCurrent(second)).toBe(true);
    expect(() => tracker.assertCurrent(first)).toThrow(StaleTaskError);
  });

  it('invalidates the active task without starting replacement work', () => {
    const tracker = createLatestTaskTracker();
    const task = tracker.begin();

    tracker.invalidate();

    expect(tracker.isCurrent(task)).toBe(false);
  });
});
