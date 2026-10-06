// Deterministic tiling albedo -> height, OpenGL (+Y) tangent normals and linear roughness.
// ImageMagick supplies PNG decoding/encoding; filtering uses wrapped neighbours only.
// npm run pbr-maps [-- --check] (MAGICK_THREAD_LIMIT=1; no downloaded assets).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PBR_PROFILES } from '../src/world/pbrProfiles.ts';

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
/** Separable box convolution on a torus. Sliding sums keep each pass linear in pixel count. */
export function wrapBlur(a: Float32Array, w: number, h: number, rx: number, ry = rx): Float32Array {
  rx = Math.min(Math.floor(rx), Math.floor((w - 1) / 2)); ry = Math.min(Math.floor(ry), Math.floor((h - 1) / 2));
  const tmp = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    let sum = 0; const row = y * w, n = 2 * rx + 1;
    for (let i = -rx; i <= rx; i++) sum += a[row + (i + w) % w];
    for (let x = 0; x < w; x++) { tmp[row + x] = sum / n; sum += a[row + (x + rx + 1) % w] - a[row + (x - rx + w) % w]; }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0; const n = 2 * ry + 1;
    for (let i = -ry; i <= ry; i++) sum += tmp[((i + h) % h) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = sum / n; sum += tmp[((y + ry + 1) % h) * w + x] - tmp[((y - ry + h) % h) * w + x]; }
  }
  return out;
}

const root = path.resolve(import.meta.dirname, '..');
const check = process.argv.includes('--check');
const dest = path.join(root, 'public/textures/pbr');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pbr-'));
const records: unknown[] = [];
const magick = (args: string[], input?: Uint8Array) => execFileSync('magick', args, { input, maxBuffer: 16 * 2 ** 20, env: { ...process.env, MAGICK_THREAD_LIMIT: '1' } });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
// Binomial smoothing preserves the narrow three-pixel brick courses better than a box blur.
function smooth(a: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) sum += a[((y+j+h)%h)*w+(x+i+w)%w] * (i === 0 ? 2 : 1) * (j === 0 ? 2 : 1);
    out[y*w+x] = sum/16;
  }
  return out;
}
function half(a: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w*h/4);
  for (let y=0; y<h/2; y++) for (let x=0; x<w/2; x++) {
    const i = 2*y*w+2*x; out[y*w/2+x] = (a[i]+a[i+1]+a[i+w]+a[i+w+1])/4;
  }
  return out;
}
function write(name: string, data: Uint8Array, w: number, h: number, gray = false): { sha256: string; bytes: number } {
  const file = path.join(temp, name);
  magick(['-size', `${w}x${h}`, '-depth', '8', gray ? 'gray:-' : 'RGB:-', '-strip', '-define', 'png:exclude-chunk=date,time', file], data);
  const content = fs.readFileSync(file), target = path.join(dest, name);
  if (check) { if (!fs.existsSync(target) || !content.equals(fs.readFileSync(target))) throw new Error(`Outdated map: ${name}`); }
  else fs.copyFileSync(file, target);
  return { sha256: sha(content), bytes: content.length };
}
try {
  if (!check) fs.mkdirSync(dest, { recursive: true });
  for (const [kind, profile] of Object.entries(PBR_PROFILES)) {
    const source = path.join(root, 'public/textures', `${kind}.png`);
    const [w,h] = magick([source, '-format', '%w %h', 'info:']).toString().split(' ').map(Number);
    const rgb = magick([source, '-alpha', 'off', '-depth', '8', 'RGB:-']);
    const lum = new Float32Array(w*h);
    for (let i=0; i<lum.length; i++) lum[i] = (rgb[3*i]*.2126+rgb[3*i+1]*.7152+rgb[3*i+2]*.0722)/255;
    const broad = wrapBlur(lum, w, h, 5), grain = smooth(lum, w, h);
    const height = new Float32Array(w*h), rough = new Float32Array(w*h);
    for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
      const i=y*w+x, hp=grain[i]-broad[i], cx=x%32, cy=47-y%48;
      const chroma = Math.max(rgb[3*i],rgb[3*i+1],rgb[3*i+2])-Math.min(rgb[3*i],rgb[3*i+1],rgb[3*i+2]);
      let relief=.08*hp, r=profile.roughness+.04*Math.abs(hp);
      if (kind.startsWith('facade_')) {
        // Known masks from gen-textures.ts distinguish glazing from masonry. Do not turn
        // window sky gradients, lit panes or white window frames into displacement.
        let pane=false, joint=false;
        if (kind === 'facade_brick') {
          const window=cx>=7&&cx<=24&&cy>=12&&cy<=38;
          pane=window&&cx!==7&&cx!==24&&cy!==12&&cy!==38&&cy!==29;
          const opening=cx>=5&&cx<=26&&cy>=10&&cy<=41;
          joint=!opening&&(y%3===2||(x+(Math.floor(y/3)%2?4:0))%8===7);
          relief=window ? -.12 : .035*hp - (joint ? .16 : 0);
        } else if (kind === 'facade_grid') {
          pane=cx>3&&cx<28&&cy>9&&cy<43&&cx!==16;
          joint=cy===9||cx===3||cx===28||cy===43||cx===16;
          relief=pane ? -.12 : .035*hp-(joint ? .14 : 0);
        } else {
          pane=cy>=13&&cx>=2&&cx<=29&&cx!==16;
          joint=cy===11||cy===12||cx<2||cx>29||cx===16;
          relief=pane ? -.07 : .02*hp-(joint ? .11 : 0);
        }
        // Frames and mortar are matte; glazing carries a broad, softer highlight.
        r=pane ? (kind==='facade_glass' ? .32 : .42)+.03*lum[i] : profile.roughness+(joint ? .06 : 0);
      } else if (kind === 'roof') {
        const seam=x%64===0||y%64===0;
        relief=.18*hp-(seam ? .14 : 0); r=.91+.07*Math.abs(hp);
      } else if (kind === 'street') {
        // Bright paint is flat on asphalt. Dark pavement grout is a recess.
        const paving=lum[i]>.6&&lum[i]<.8&&chroma<8;
        relief=paving ? .12*hp-Math.max(0,broad[i]-lum[i])*.4 : .035*hp;
        r=lum[i]>.8||chroma>12 ? .76 : profile.roughness+.04*Math.abs(hp);
      } else if (kind === 'water') {
        relief=(grain[i]-.85)*.25;
        // Water occupies low spots: smoother troughs, slightly rougher ripple crests.
        const pool=clamp((.9-broad[i])/.14);
        r=.18-.10*pool;
      }
      height[i]=clamp(.5+relief); rough[i]=clamp(r,.07,.99);
    }
    const heights=smooth(height,w,h), roughness=smooth(rough,w,h);
    const normal=new Uint8Array(w*h*3);
    for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
      const i=y*w+x;
      // Image rows increase downwards; V increases upwards after TextureLoader's flipY.
      let nx=-(heights[y*w+(x+1)%w]-heights[y*w+(x-1+w)%w])*.5*profile.strength;
      let ny=(heights[((y+1)%h)*w+x]-heights[((y-1+h)%h)*w+x])*.5*profile.strength;
      const cap=Math.min(1,.5/Math.max(Math.hypot(nx,ny),1e-8)); nx*=cap; ny*=cap;
      const len=Math.hypot(nx,ny,1);
      normal[3*i]=Math.round((nx/len*.5+.5)*255); normal[3*i+1]=Math.round((ny/len*.5+.5)*255); normal[3*i+2]=Math.round((1/len*.5+.5)*255);
    }
    const outputs = {
      normal: write(`${kind}_normal.png`,normal,w,h),
      height: write(`${kind}_height.png`,Uint8Array.from(heights,v=>Math.round(v*255)),w,h,true),
      roughness: write(`${kind}_roughness.png`,Uint8Array.from(roughness,v=>Math.round(v*255)),w,h,true),
      roughnessLow: write(`${kind}_roughness_low.png`,Uint8Array.from(half(roughness,w,h),v=>Math.round(v*255)),w/2,h/2,true),
    };
    records.push({ albedo: `/textures/${kind}.png`, albedoSha256:sha(fs.readFileSync(source)), size:[w,h], profile, outputs });
    console.log(`${check?'checked':'made'} ${kind}: height, normal, roughness and half-size roughness`);
  }
  const manifest=JSON.stringify({ version:1, convention:'OpenGL +Y; linear data; periodic filters and gradients', records },null,2)+'\n';
  const file=path.join(dest,'manifest.json');
  if (check) { if (fs.readFileSync(file,'utf8')!==manifest) throw new Error('Outdated PBR manifest'); }
  else fs.writeFileSync(file,manifest);
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
