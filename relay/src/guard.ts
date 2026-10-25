// Pure input checks: world position and tag claims are never accepted from a client.
export function validInputWord(word: number): boolean {
  if (!Number.isInteger(word) || word < 0 || word >= 2 ** 41) return false;
  const lo = word % 2 ** 32, hi = Math.floor(word / 2 ** 32);
  const signed = (x: number) => ((x & 255) << 24) >> 24;
  // The client records normalized sticks/keys (diagonal keys may use both axes).
  return Math.abs(signed(lo >>> 10)) <= 64 && Math.abs(signed(lo >>> 18)) <= 64 && Math.abs(signed(hi)) <= 100;
}

/** Bounded, refillable quota; callers supply a trusted network or authenticated wallet. */
export class Quotas {
  private readonly buckets = new Map<string, { credit: number; at: number }>();
  take(key: string, now: number, burst: number, perMinute: number): boolean {
    // Expire idle entries before enforcing the hard memory bound.
    if (this.buckets.size >= 4096) for (const [k, b] of this.buckets) if (now - b.at > 600_000) this.buckets.delete(k);
    let b = this.buckets.get(key);
    if (!b) { if (this.buckets.size >= 4096) return false; b = { credit: burst, at: now }; this.buckets.set(key, b); }
    b.credit = Math.min(burst, b.credit + Math.max(0, now - b.at) * perMinute / 60000); b.at = now;
    if (b.credit < 1) return false;
    b.credit--; return true;
  }
}
