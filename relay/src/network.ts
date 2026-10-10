/** Cloudflare supplies this header; client identity fields never choose a rate bucket. */
export async function networkBucket(request: Request, dev = false, secret = ''): Promise<string | null> {
  const ip = request.headers.get('CF-Connecting-IP');
  let address: string;
  if (!ip && dev) address = 'local';
  else if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip.split('.').every(part => Number(part) <= 255)) address = 'ipv4:' + ip.split('.').map(Number).join('.');
  else {
    if (!ip || ip.length > 64 || !/^[0-9a-f:.]+$/i.test(ip)) return null;
    try {
      const canonical = new URL('http://[' + ip + ']/').hostname.slice(1, -1);
      const [left, right] = canonical.split('::'), head = left ? left.split(':') : [], tail = right ? right.split(':') : [];
      const words = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail].map(word => parseInt(word, 16));
      address = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff
        ? 'ipv4:' + [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.')
        : 'ipv6:' + words.slice(0, 4).map(word => word.toString(16)).join(':') + '/64';
    } catch { return null; }
  }
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret + '\0network\0' + address));
  return 'network:' + [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
}
