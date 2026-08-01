import { NONE, driftLabel, relativeSince, shortSha } from './format';

describe('shortSha', () => {
  it('abbreviates to seven characters, as git does', () => {
    expect(shortSha('9f2c1ab3d4e5f60718293a4b5c6d7e8f90123456')).toBe('9f2c1ab');
  });

  it('leaves a sha shorter than seven characters alone', () => {
    expect(shortSha('9f2c')).toBe('9f2c');
  });
});

describe('driftLabel', () => {
  it('says nothing when the counts are unknown', () => {
    // Null is "the service could not measure it", not zero. A branch reported as up to date
    // because nothing counted it would be the list's one outright lie.
    expect(driftLabel(null, null)).toBe('');
    expect(driftLabel(3, null)).toBe('');
  });

  it('says so when the branch is level with its parent', () => {
    expect(driftLabel(0, 0)).toBe('up to date');
  });

  it('names only the direction that is non-zero', () => {
    expect(driftLabel(3, 0)).toBe('3 ahead');
    expect(driftLabel(0, 2)).toBe('2 behind');
  });

  it('names both when the branch has diverged', () => {
    expect(driftLabel(3, 2)).toBe('3 ahead · 2 behind');
  });
});

describe('relativeSince', () => {
  const now = new Date('2026-08-01T12:00:00Z');

  it('calls anything under a minute just now, because it is', () => {
    expect(relativeSince('2026-08-01T11:59:30Z', now)).toBe('just now');
  });

  it('drops to the coarsest unit that is still true', () => {
    expect(relativeSince('2026-08-01T11:56:00Z', now)).toBe('4m ago');
    expect(relativeSince('2026-08-01T10:00:00Z', now)).toBe('2h ago');
    expect(relativeSince('2026-07-29T12:00:00Z', now)).toBe('3d ago');
  });

  it('never reports the future as a negative age', () => {
    expect(relativeSince('2026-08-01T12:05:00Z', now)).toBe('just now');
  });

  it('draws nothing rather than Invalid Date for a timestamp it cannot read', () => {
    expect(relativeSince('not a time', now)).toBe(NONE);
  });
});
