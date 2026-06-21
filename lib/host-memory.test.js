import {
  parseLinuxMeminfo,
  parseDarwinVmStat,
  availableMemoryRatio,
  _resetAvailableMemoryCache,
} from './host-memory.js';

describe('parseLinuxMeminfo', () => {
  it('uses MemAvailable / MemTotal when present', () => {
    const text = [
      'MemTotal:       16384000 kB',
      'MemFree:          512000 kB',
      'MemAvailable:   12000000 kB',
      'Buffers:          100000 kB',
      'Cached:          8000000 kB',
    ].join('\n');
    // 12000000 / 16384000 ≈ 0.7324 — NOT the tiny MemFree figure.
    expect(parseLinuxMeminfo(text)).toBeCloseTo(12000000 / 16384000, 5);
  });

  it('falls back to free + buffers + cached on pre-3.14 kernels (no MemAvailable)', () => {
    const text = [
      'MemTotal:       16384000 kB',
      'MemFree:          512000 kB',
      'Buffers:          100000 kB',
      'Cached:          8000000 kB',
    ].join('\n');
    expect(parseLinuxMeminfo(text)).toBeCloseTo(
      (512000 + 100000 + 8000000) / 16384000,
      5,
    );
  });

  it('returns null when required fields are missing', () => {
    expect(parseLinuxMeminfo('Totally: not meminfo\n')).toBeNull();
    expect(parseLinuxMeminfo('MemTotal:       16384000 kB\n')).toBeNull();
  });
});

describe('parseDarwinVmStat', () => {
  // 16 KiB page size, 24 GiB box.
  const totalBytes = 24 * 1024 * 1024 * 1024;
  const pageSize = 16384;
  const sample = (pages) =>
    [
      `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)`,
      `Pages free:                                   ${pages.free}.`,
      `Pages active:                                 ${pages.active}.`,
      `Pages inactive:                               ${pages.inactive}.`,
      `Pages speculative:                            ${pages.speculative}.`,
      `Pages wired down:                             ${pages.wired}.`,
      `Pages purgeable:                              ${pages.purgeable}.`,
    ].join('\n');

  it('counts free + inactive + speculative + purgeable as available', () => {
    // The exact "healthy heavy build" shape: almost no truly-free pages, but lots of inactive cache.
    const text = sample({
      free: 5000,
      active: 100000,
      inactive: 800000, // ~12.5 GB reclaimable
      speculative: 6000,
      wired: 165000,
      purgeable: 40,
    });
    const reclaimablePages = 5000 + 800000 + 6000 + 40;
    expect(parseDarwinVmStat(text, totalBytes)).toBeCloseTo(
      (reclaimablePages * pageSize) / totalBytes,
      5,
    );
  });

  it('reads available far above the bare free-page ratio', () => {
    const text = sample({
      free: 5000,
      active: 100000,
      inactive: 800000,
      speculative: 6000,
      wired: 165000,
      purgeable: 40,
    });
    const freeOnlyRatio = (5000 * pageSize) / totalBytes; // what os.freemem() would imply (~0.3%)
    const ratio = parseDarwinVmStat(text, totalBytes);
    expect(freeOnlyRatio).toBeLessThan(0.01);
    expect(ratio).toBeGreaterThan(0.45); // available is ~50% — no false abort
  });

  it('defaults missing reclaimable buckets to zero but still needs free + total', () => {
    const text = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                   100000.',
    ].join('\n');
    expect(parseDarwinVmStat(text, totalBytes)).toBeCloseTo(
      (100000 * pageSize) / totalBytes,
      5,
    );
    expect(parseDarwinVmStat('no pages here', totalBytes)).toBeNull();
    expect(parseDarwinVmStat(text, 0)).toBeNull();
  });
});

describe('availableMemoryRatio', () => {
  afterEach(() => _resetAvailableMemoryCache());

  it('returns a finite fraction in [0,1] on the host it runs on', () => {
    _resetAvailableMemoryCache();
    const r = availableMemoryRatio();
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
  });
});
