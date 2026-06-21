import os from 'os';
import fs from 'fs';
import { execSync } from 'child_process';

/**
 * @file host-memory.js
 * @description Cross-platform "available memory" reader for the memory governor.
 *
 * Node's `os.freemem()` does NOT mean "memory you can use". On Linux it maps to `MemFree` and on
 * macOS to the Mach `free` page count — both of which EXCLUDE reclaimable cache (file-backed,
 * inactive, speculative, purgeable pages). Under a heavy build these reclaimable pages balloon while
 * truly-free pages crater toward zero, even though the box is perfectly healthy and not swapping.
 * Driving the governor off `os.freemem()` therefore makes it abort healthy cold runs.
 *
 * The right signal is *available* memory = free + reclaimable. This module computes it per platform:
 *
 *   - linux : `/proc/meminfo`'s `MemAvailable` (the kernel's own estimate of allocatable memory),
 *             read with `fs` — no subprocess.
 *   - darwin: `vm_stat`'s free + inactive + speculative + purgeable pages.
 *   - win32 & others: `os.freemem()` already reports *available* physical memory on Windows, so we
 *             fall back to it.
 *
 * Every path is defensive: any parse/exec/permission failure (or an unsupported platform) falls back
 * to `os.freemem()/os.totalmem()`, so the governor degrades to its old behaviour rather than breaking
 * on a platform we don't special-case.
 */

/** Parse `/proc/meminfo` text into an available-memory fraction, or null if the fields are absent. */
export function parseLinuxMeminfo(text) {
  const field = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const total = field('MemTotal');
  let available = field('MemAvailable');
  // Older kernels (< 3.14) lack MemAvailable — approximate it from free + buffers + cached.
  if (available == null) {
    const free = field('MemFree');
    const buffers = field('Buffers');
    const cached = field('Cached');
    if (free != null && cached != null) {
      available = free + (buffers ?? 0) + cached;
    }
  }
  if (!total || available == null) return null;
  return available / total;
}

/**
 * Parse `vm_stat` output into an available-memory fraction against `totalBytes`.
 * Available = (free + inactive + speculative + purgeable) pages, which are all reclaimable without
 * blocking the run. Returns null if the page size or page counts can't be read.
 */
export function parseDarwinVmStat(text, totalBytes) {
  const sizeMatch = text.match(/page size of (\d+) bytes/);
  const pageSize = sizeMatch ? Number(sizeMatch[1]) : 4096;
  const pages = (label) => {
    const m = text.match(new RegExp(`Pages ${label}:\\s+(\\d+)\\.`));
    return m ? Number(m[1]) : null;
  };
  const free = pages('free');
  const inactive = pages('inactive');
  const speculative = pages('speculative');
  const purgeable = pages('purgeable');
  if (free == null) return null;
  if (!totalBytes || !Number.isFinite(totalBytes)) return null;
  const reclaimablePages =
    free + (inactive ?? 0) + (speculative ?? 0) + (purgeable ?? 0);
  return (reclaimablePages * pageSize) / totalBytes;
}

/** Platform-specific available ratio, or null when this platform has no special case / it failed. */
function platformAvailableRatio() {
  try {
    if (process.platform === 'linux') {
      return parseLinuxMeminfo(fs.readFileSync('/proc/meminfo', 'utf8'));
    }
    if (process.platform === 'darwin') {
      const out = execSync('vm_stat', { encoding: 'utf8', timeout: 1000 });
      return parseDarwinVmStat(out, os.totalmem());
    }
  } catch {
    return null; // fall back below
  }
  return null; // win32 & others: os.freemem() is already "available" — handled by the fallback
}

// Short-lived cache so the governor's several reads per poll iteration don't each spawn `vm_stat`.
let _cache = { at: 0, val: null };
const CACHE_TTL_MS = 250;

/**
 * Fraction [0,1] of *available* physical RAM (free + reclaimable cache). Falls back to
 * `os.freemem()/os.totalmem()` on any unsupported platform or failure, so it always returns a usable
 * number and never throws.
 */
export function availableMemoryRatio() {
  const now = Date.now();
  if (_cache.val != null && now - _cache.at < CACHE_TTL_MS) return _cache.val;

  let ratio = platformAvailableRatio();
  if (ratio == null || !Number.isFinite(ratio)) {
    const total = os.totalmem();
    ratio = total ? os.freemem() / total : 1;
  }
  ratio = Math.min(1, Math.max(0, ratio));
  _cache = { at: now, val: ratio };
  return ratio;
}

/** Test-only: clear the memoised reading so a fresh probe runs on the next call. */
export function _resetAvailableMemoryCache() {
  _cache = { at: 0, val: null };
}
