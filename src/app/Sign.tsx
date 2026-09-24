// "Sign": a registered r3g component for decor.json billboards and banners - a flat unlit panel with
// painted text (canvas texture), editable in ?editor=decor (text, colours, size). Faces the node's +Z;
// front side only (give a billboard a backing box behind it). No font files: the text is drawn with
// the system monospace font, so nothing extra ships.
import { useEffect, useMemo } from "react";
import { CanvasTexture, FrontSide, SRGBColorSpace } from "three";
import { registerComponent, type Component, type ComponentViewProps } from "react-three-game";

export type SignProperties = {
  text?: string;
  color?: string;
  background?: string;
  border?: string;
  width?: number;
  height?: number;
};

function paint(p: Required<SignProperties>): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const aspect = Math.max(0.1, p.width / Math.max(0.01, p.height));
  c.width = aspect >= 1 ? 512 : Math.max(64, Math.round(512 * aspect));
  c.height = aspect >= 1 ? Math.max(64, Math.round(512 / aspect)) : 512;
  const x = c.getContext("2d");
  if (!x) return c;
  x.fillStyle = p.background;
  x.fillRect(0, 0, c.width, c.height);
  const bw = Math.round(Math.min(c.width, c.height) * 0.06);
  if (p.border) {
    x.strokeStyle = p.border;
    x.lineWidth = bw;
    x.strokeRect(bw / 2, bw / 2, c.width - bw, c.height - bw);
  }
  const lines = p.text.split("\\n").flatMap(l => l.split("\n"));
  const vertical = aspect < 0.6;
  x.fillStyle = p.color;
  x.textAlign = "center";
  x.textBaseline = "middle";
  if (vertical && lines.length === 1) {
    // Tall banner: one letter per row.
    const chars = [...lines[0]];
    const size = Math.min((c.height - bw * 4) / chars.length, c.width - bw * 4) * 0.92;
    x.font = `900 ${size}px ui-monospace, Menlo, Consolas, monospace`;
    chars.forEach((ch, i) => x.fillText(ch, c.width / 2, bw * 2 + size * (i + 0.5) / 0.92 * 0.98));
    return c;
  }
  const inner = c.width - bw * 4, innerH = c.height - bw * 4;
  let size = innerH / lines.length * 0.8;
  x.font = `900 ${size}px ui-monospace, Menlo, Consolas, monospace`;
  const widest = Math.max(...lines.map(l => x.measureText(l).width), 1);
  if (widest > inner) size *= inner / widest;
  x.font = `900 ${size}px ui-monospace, Menlo, Consolas, monospace`;
  const lh = size * 1.12;
  lines.forEach((l, i) => x.fillText(l, c.width / 2, c.height / 2 + (i - (lines.length - 1) / 2) * lh));
  return c;
}

function SignView({ properties, children }: ComponentViewProps<SignProperties>) {
  const p: Required<SignProperties> = {
    text: properties.text ?? "gm",
    color: properties.color ?? "#16161d",
    background: properties.background ?? "#f2c14e",
    border: properties.border ?? "#16161d",
    width: properties.width ?? 8,
    height: properties.height ?? 3,
  };
  const key = JSON.stringify(p);
  const tex = useMemo(() => {
    const t = new CanvasTexture(paint(p));
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    return t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <>
      <mesh frustumCulled>
        <planeGeometry args={[p.width, p.height]} />
        <meshBasicMaterial map={tex} side={FrontSide} />
      </mesh>
      {children}
    </>
  );
}

export const Sign: Component<SignProperties> = {
  name: "Sign",
  View: SignView,
  properties: {
    text: { type: "string", default: "gm" },
    color: { type: "color", default: "#16161d" },
    background: { type: "color", default: "#f2c14e" },
    border: { type: "color", default: "#16161d" },
    width: { default: 8, min: 0.2, step: 0.1 },
    height: { default: 3, min: 0.2, step: 0.1 },
  },
};

registerComponent(Sign);
