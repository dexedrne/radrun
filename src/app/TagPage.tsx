// The ?tag page (a lazy chunk): SPIDER-TAG. Offline: you against 1-3 bots in the page's district, a 3-minute match,
// lowest bag time wins. ONLINE lazily loads the net chunk (net/online.tsx: the lobby, the relay transport and the
// rollback link) only when pressed or when the page is opened from a room link (?tag&room=CODE).
// One canvas, mounted once; a match is a fresh TagMatch outside React (nothing remounts).
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import type { Vector3 } from "three";
import { TagGame } from "../game/tagGame.ts";
import { TAG, type TagSlot } from "../game/tagMatch.ts";
import { BOT_LEVELS, type BotLevel } from "../game/tagBot.ts";
import { RADBROS, type RadbroId } from "../game/round.ts";
import { randomSeed } from "../game/play.ts";
import { Rand } from "../sim/math.ts";
import {
  EV_ATTACH, EV_BONK, EV_CLIMB, EV_DJUMP, EV_JUMP, EV_LAND, EV_LEDGE, EV_NOANCHOR, EV_ROLL, EV_SLIDE, EV_VAULT, EV_WALLJUMP, EV_WALLRUN, EV_YANK, EV_ZIP,
} from "../sim/player.ts";
import { PH_COUNTDOWN, PH_OVER, TAG_KIND_YANK, TAG_KIND_YOINK } from "../game/tagMatch.ts";
import { applyTuningJson, type TuningJson } from "../sim/tuning.ts";
import type { CityModel } from "../world/cityModel.ts";
import { DISTRICTS, TUNING_URL } from "../world/districts.ts";
import { PAGE_DISTRICT, gotoDistrict, lv } from "./district.ts";
import { SceneCanvas, playPrefab } from "./GameScene.tsx";
import { AssetsBridge, clipsPath, CLIP_META, loadManifest, modelPath } from "./characters.ts";
import { StructuresView } from "./StructuresView.tsx";
import { CameraView } from "./CameraView.tsx";
import { FxView } from "./FxView.tsx";
import { MAX_TAGS, SLOT_COLORS, TagActors, tagRigs } from "./TagActors.tsx";
import { useFrame } from "@react-three/fiber";
import { FRAME } from "./frame.ts";
import { useUi } from "../ui/store.ts";
import { attachDom } from "../input/input.ts";
import { requestLock } from "../radbro/bridge.ts";
import { btn, layer, panel, scroller } from "../ui/screens.tsx";
import { RADBRO_COLOR } from "../ui/strings.ts";
import { TouchControls } from "../ui/TouchControls.tsx";
import { applySettings, loadSettings } from "../ui/prefs.ts";
import { setAudioVolumes, setMuted, unlockAudio } from "../audio/engine.ts";
import { preloadSfx, sfx } from "../audio/sfx.ts";
import { safe } from "../ui/safe.ts";

const DEV = import.meta.env.MODE !== "production";
const params = new URLSearchParams(location.search);
/** ?tag&bot[=chill|normal|sharp]: your slot plays itself (dev / test builds; headless checks). */
const AUTO: BotLevel | null = DEV && params.has("bot") ? ((params.get("bot") || "normal") as BotLevel) : null;
/** ?secs=N: match length override (dev / test builds). */
const SECS = DEV && params.has("secs") ? Math.max(10, Number(params.get("secs")) || 180) : null;
const ROOM = params.get("room");
/** The working name; the public name is still the owner's call (DESIGN §8 decision 15). */
export const TAG_NAME = "SPIDER-TAG";
/** The online lobby + relay transport + rollback: a separate chunk, fetched only when ONLINE is pressed (or a room link). */
const Online = lazy(() => import("../net/online.tsx"));

export type TagScreen = "boot" | "menu" | "loading" | "match" | "results" | "online";
export type HudRow = { slot: number; radbro: RadbroId; name: string; bag: number; holder: boolean; you: boolean; frozen: boolean; tags: number; falls: number };
export type TagHud = { clock: number; countdown: number; phase: number; rows: HudRow[]; holder: number; local: number; frozen: number; lock: number; online: boolean; stall: boolean };
type Flash = { text: string; sub?: string; color: string; t: number };

export type TagUi = {
  screen: TagScreen;
  slots: RadbroId[];
  names: string[];
  hud: TagHud | null;
  flash: Flash | null;
  load: { progress: number; error: string | null };
  /** Online results: both clients agreed on the final state (null = offline / not known yet). */
  agreed: boolean | null;
  /** Online controls the results screen calls (set by the lazy net chunk). */
  net: { rematch: () => void; leave: () => void } | null;
  netStatus: string;
};

export const useTag = create<TagUi>(() => ({
  screen: "boot", slots: [], names: [], hud: null, flash: null, load: { progress: 0, error: null }, agreed: null, net: null, netStatus: "",
}));

declare global {
  interface Window {
    __tag?: {
      screen: string; phase: number; step: number; clock: number; holder: number; local: number; n: number; bag: number[]; tags: number[]; falls: number[];
      hash: string; over: boolean; final: boolean; tagsTotal: number; online: boolean; agreed: boolean | null;
    };
  }
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(`${url}?v=${Date.now()}`);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

let booting: Promise<TagGame> | null = null;
function bootTag(): Promise<TagGame> {
  booting ??= (async () => {
    const [model, tuningJson] = await Promise.all([getJson<CityModel>(lv("city.model.json")), getJson<TuningJson & { tag?: Partial<typeof TAG> }>(TUNING_URL)]);
    if (!model) throw new Error(`${lv("city.model.json")} missing: run npm run level`);
    const { player, camera } = applyTuningJson(tuningJson, m => console.info(m));
    // tuning.json "tag": the tag table (the same file for every client of a room; its hash is checked online).
    for (const [k, v] of Object.entries(tuningJson?.tag ?? {})) if (k in TAG && typeof v === typeof (TAG as Record<string, unknown>)[k]) (TAG as Record<string, unknown>)[k] = v;
    return new TagGame(model, player, camera);
  })();
  return booting;
}

/** Load the models + clip packs of the given Radbros (the LOADING bar). */
export async function loadRadbros(ids: RadbroId[]): Promise<boolean> {
  const uniq = [...new Set(ids)];
  const paths: string[] = [];
  for (const id of uniq) { paths.push(modelPath(id)); if (CLIP_META[id]?.clipPack) paths.push(clipsPath(id)); }
  useTag.setState({ load: { progress: 0, error: null } });
  const failed = await loadManifest(paths, f => useTag.setState({ load: { progress: f, error: null } }));
  if (failed) { useTag.setState(s => ({ load: { progress: s.load.progress, error: failed } })); return false; }
  return true;
}

// ---- canvas ------------------------------------------------------------------------------------------------

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function localSfx(ev: number): void {
  if (ev & EV_ATTACH) sfx.thwip();
  if (ev & (EV_ZIP | EV_YANK)) sfx.zip();
  if (ev & EV_JUMP) sfx.jump();
  if (ev & EV_DJUMP) sfx.djump();
  if (ev & EV_LAND) sfx.land(6);
  if (ev & EV_BONK) sfx.bonk();
  if (ev & EV_WALLRUN) sfx.wallRun();
  if (ev & EV_WALLJUMP) sfx.wallJump();
  if (ev & EV_LEDGE) sfx.ledge();
  if (ev & EV_CLIMB) sfx.climb();
  if (ev & EV_VAULT) sfx.vault();
  if (ev & EV_SLIDE) sfx.slide();
  if (ev & EV_ROLL) sfx.roll();
  if (ev & EV_NOANCHOR) sfx.noAnchor();
}

/** Fixed steps each frame, SFX, flashes, the 10 Hz HUD push and window.__tag. */
function TagDriver({ game }: { game: TagGame }) {
  const st = useMemo(() => ({ acc: 0, runId: -1, beep: 4, tags: 0, shownTag: -1, go: false }), []);
  useFrame((_, delta) => {
    game.frame(delta);
    const m = game.match;
    if (!m) return;
    const ui = useTag.getState();
    if (game.runId !== st.runId) { st.runId = game.runId; st.beep = 4; st.tags = 0; st.shownTag = -1; st.go = false; }
    localSfx(game.frameEvents);
    // Countdown beeps, GO.
    if (m.phase === PH_COUNTDOWN) {
      const left = Math.ceil(m.countdown / 120);
      if (left < st.beep && left > 0) { st.beep = left; sfx.beep(); }
    }
    // GO and tags are presented from the match state, not from step events: online, a tag first seen in a rollback
    // re-sim (the other player's press arrived late) still flashes, and one a rollback undoes never flashes twice.
    if (!st.go && m.phase !== PH_COUNTDOWN) { st.go = true; sfx.beep(true); flash(m.holder === game.local ? "YOU HOLD THE BAG" : "RUN!", m.holder === game.local ? "tag someone to pass it" : `${ui.names[m.holder] ?? "?"} holds the bag`, m.holder === game.local ? "#ff3355" : "#9fe6ff"); }
    if (m.lastTagStep > st.shownTag) {
      st.shownTag = m.lastTagStep;
      st.tags++;
      const kind = m.lastTagKind === TAG_KIND_YOINK ? "YOINKED" : m.lastTagKind === TAG_KIND_YANK ? "YANKED" : "TAGGED";
      if (m.lastTagTo === game.local) { sfx.bonk(); flash(`${kind}!`, "you hold the bag · web-tangled", "#ff3355"); }
      else if (m.lastTagFrom === game.local) { sfx.yoink(); sfx.jingle(); flash("TAG!", `${ui.names[m.lastTagTo] ?? "?"} holds the bag`, "#8dff8a"); }
      else flash(`${ui.names[m.lastTagTo] ?? "?"} ${kind.toLowerCase()}`, `by ${ui.names[m.lastTagFrom] ?? "?"}`, "#ffd23f");
    }
    const final = game.link ? game.link.final : m.over;
    if (m.over && final && ui.screen === "match" && game.overT > 1.6) {
      document.exitPointerLock?.();
      useTag.setState({ screen: "results" });
    }
    st.acc += delta;
    if (st.acc >= 0.1) {
      st.acc = 0;
      const rows: HudRow[] = [];
      for (let i = 0; i < m.n; i++) rows.push({
        slot: i, radbro: ui.slots[i], name: ui.names[i] ?? `#${ui.slots[i]}`, bag: m.bag[i] / 120, holder: i === m.holder, you: i === game.local,
        frozen: m.freeze[i] > 0, tags: m.tags[i], falls: m.falls[i],
      });
      useTag.setState({
        hud: { clock: m.clock / 120, countdown: m.countdown / 120, phase: m.phase, rows, holder: m.holder, local: game.local, frozen: m.freeze[game.local] / 120, lock: m.lock[game.local] / 120, online: !!game.link, stall: false },
      });
      // Name tags: bag clocks over the others.
      for (let i = 0; i < m.n; i++) {
        const el = document.getElementById(`rr-tag-${i}`);
        if (el) {
          el.textContent = `${i === m.holder ? "💰 " : ""}${ui.names[i] ?? ""} · ${(m.bag[i] / 120).toFixed(1)}s`;
          el.style.color = i === m.holder ? "#ff6b86" : "#fff";
        }
      }
      window.__tag = {
        screen: ui.screen, phase: m.phase, step: m.step, clock: m.clock, holder: m.holder, local: game.local, n: m.n, bag: [...m.bag], tags: [...m.tags],
        falls: [...m.falls], hash: m.hashHex(), over: m.over, final, tagsTotal: st.tags, online: !!game.link, agreed: ui.agreed,
      };
    }
  }, FRAME.sim);
  return null;
}

function flash(text: string, sub: string, color: string): void {
  useTag.setState({ flash: { text, sub, color, t: performance.now() } });
}

function TagScene({ game }: { game: TagGame }) {
  const prefab = useMemo(() => playPrefab(game, { nodes: [], materials: {} }), [game]);
  const slots = useTag(s => s.slots);
  const hidePlayer = useCallback(() => game.mode !== "match", [game]);
  const ropeFrom = useCallback((out: Vector3) => {
    const r = tagRigs[game.local];
    return !!r?.bones.rightHand && r.root.visible && !!r.bones.rightHand.getWorldPosition(out);
  }, [game]);
  return (
    <SceneCanvas prefab={prefab}>
      <AssetsBridge />
      <StructuresView model={game.model} district={PAGE_DISTRICT} />
      <TagDriver game={game} />
      <TagActors game={game} slots={slots} />
      <CameraView game={game} ropeDrop={1} />
      <FxView game={game} hidePlayer={hidePlayer} ropeFrom={ropeFrom} />
    </SceneCanvas>
  );
}

// ---- screens -----------------------------------------------------------------------------------------------

function Card({ id, on, onPick, size }: { id: RadbroId; on: boolean; onPick: () => void; size: number }) {
  return (
    <button onClick={onPick} data-testid={`tag-card-${id}`} style={{
      width: size + 22, padding: "8px 4px", borderRadius: 10, cursor: "pointer", color: "#fff", font: "700 12px ui-monospace, monospace",
      background: on ? "rgba(255,61,127,0.35)" : "rgba(255,255,255,0.06)", border: on ? "2px solid #ff3d7f" : "2px solid rgba(255,255,255,0.2)",
    }}>
      <div style={{ margin: "0 auto 6px", width: size, height: size, borderRadius: 10, overflow: "hidden", background: `radial-gradient(circle at 50% 38%, ${RADBRO_COLOR[id].body}66, ${RADBRO_COLOR[id].accent}22 62%, rgba(0,0,0,0.25))` }}>
        <img src={`/ui/radbro${id}.webp`} alt="" width={size} height={size} draggable={false} style={{ display: "block", width: size, height: size }} />
      </div>
      <div>#{id}</div>
    </button>
  );
}

const pick = (on: boolean, color = "#ffd23f"): React.CSSProperties => ({ ...btn(false), padding: "8px 14px", fontSize: 14, background: on ? "rgba(255,210,63,0.28)" : "rgba(255,255,255,0.06)", borderColor: on ? color : "rgba(255,255,255,0.35)" });

function Menu(props: { radbro: RadbroId; setRadbro: (r: RadbroId) => void; bots: number; setBots: (n: number) => void; level: BotLevel; setLevel: (l: BotLevel) => void; ready: boolean; onPlay: () => void; onOnline: () => void }) {
  const small = innerHeight < 560 || innerWidth < 700;
  const size = small ? 54 : 88;
  return (
    <div style={{ ...scroller, background: "linear-gradient(180deg, rgba(10,12,30,0.2), rgba(10,12,30,0.6))" }} data-testid="tag-menu">
      <div style={{ margin: "auto", textAlign: "center", maxWidth: 760, padding: small ? 8 : 16, boxSizing: "border-box" }}>
        <div style={{ font: `900 ${small ? 34 : 60}px/1 ui-monospace, monospace`, letterSpacing: small ? 3 : 6, color: "#fff", textShadow: "4px 4px 0 #ff3d7f, 8px 8px 0 rgba(0,0,0,0.35)" }}>{TAG_NAME}</div>
        <div style={{ marginTop: 8, fontSize: small ? 12 : 14, textShadow: "0 1px 2px #000" }}>
          web-slinger tag in {DISTRICTS[PAGE_DISTRICT].name}: whoever holds the bag chases. Touch, Yoink or yank someone to pass it. Least bag time at the horn wins.
        </div>
        <div style={{ ...panel, marginTop: small ? 8 : 14, padding: small ? "8px 10px" : panel.padding }}>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>pick your Radbro</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            {RADBROS.map(id => <Card key={id} id={id} on={id === props.radbro} onPick={() => props.setRadbro(id)} size={size} />)}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
            <span style={{ fontSize: 12, opacity: 0.8 }}>bots</span>
            {[1, 2, 3].map(n => <button key={n} style={pick(props.bots === n)} onClick={() => props.setBots(n)} data-testid={`tag-bots-${n}`}>{n}</button>)}
            <span style={{ fontSize: 12, opacity: 0.8, marginLeft: 8 }}>level</span>
            {(Object.keys(BOT_LEVELS) as BotLevel[]).map(l => <button key={l} style={pick(props.level === l, l === "sharp" ? "#ff3d7f" : "#ffd23f")} onClick={() => props.setLevel(l)} data-testid={`tag-level-${l}`}>{l}</button>)}
          </div>
          <div style={{ fontSize: 11, opacity: 0.75, marginTop: 6 }}>
            {props.level === "chill" ? "chill bots only run once you get close, and swing without the new tech" : props.level === "normal" ? "normal bots use the whole kit and run once you're within 75 m" : "sharp bots never stop moving and time their releases"}
            {" · "}3:00 match
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 12, flexWrap: "wrap" }}>
            <button onClick={props.onPlay} disabled={!props.ready} style={{ ...btn(true), fontSize: 20, padding: "10px 40px", opacity: props.ready ? 1 : 0.5 }} data-testid="tag-play">
              {props.ready ? "PLAY vs BOTS" : "loading city…"}
            </button>
            <button onClick={props.onOnline} disabled={!props.ready} style={{ ...btn(false), fontSize: 16, padding: "10px 22px", borderColor: "#9fe6ff", color: "#cdf3ff", opacity: props.ready ? 1 : 0.5 }} data-testid="tag-online">
              ONLINE
            </button>
          </div>
        </div>
        <div style={{ ...panel, marginTop: 10, fontSize: 12, lineHeight: 1.7, textAlign: "left", display: "inline-block" }}>
          <b>holding the bag</b>: get within 1.5 m, or <b>click</b> when your ring on them turns red (Yoink, 3.5 m), or <b>E</b> in yank range (9 m) to zip onto them.<br />
          <b>tagged</b>: you're web-tangled for 1.5 s and can't tag them straight back for 3 s. <b>Q</b> / right mouse looks at the bagholder.<br />
          every move from the chase works: swing, zip, wall run, ledge grab, slide, <b>C</b> hold to charge-jump.
        </div>
        <div style={{ marginTop: 10 }}>
          <button onClick={() => gotoDistrict(PAGE_DISTRICT)} style={{ ...btn(false), fontSize: 12, padding: "6px 14px" }} data-testid="tag-back">← back to RadRun</button>
        </div>
      </div>
    </div>
  );
}

function Hud() {
  const hud = useTag(s => s.hud);
  const flashS = useTag(s => s.flash);
  const [now, setNow] = useState(performance.now());
  useEffect(() => { const iv = setInterval(() => setNow(performance.now()), 100); return () => clearInterval(iv); }, []);
  const slots = useTag(s => s.slots);
  if (!hud) return null;
  const you = hud.rows[hud.local];
  const holding = hud.holder === hud.local;
  const showFlash = flashS && now - flashS.t < 1800;
  const cd = hud.phase === PH_COUNTDOWN ? Math.ceil(hud.countdown) : 0;
  return (
    <div style={{ ...layer, pointerEvents: "none", font: "700 14px ui-monospace, monospace", color: "#fff" }} data-testid="tag-hud">
      <div style={{ position: "absolute", top: safe("top", 10), left: "50%", transform: "translateX(-50%)", textAlign: "center" }}>
        <div style={{ fontSize: 30, fontWeight: 900, textShadow: "0 2px 4px #000" }} data-testid="tag-clock">{fmt(hud.clock)}</div>
        <div style={{ fontSize: 13, marginTop: 2, color: holding ? "#ff6b86" : "#cdf3ff", textShadow: "0 1px 3px #000" }}>
          {hud.phase === PH_OVER ? "time!" : holding ? "you hold the bag · tag someone" : `${hud.rows[hud.holder]?.name ?? "?"} holds the bag · run`}
        </div>
      </div>
      <div style={{ position: "absolute", top: safe("top", 10), left: safe("left", 12), ...panel, padding: "8px 10px", fontSize: 13, minWidth: 170 }} data-testid="tag-board">
        {[...hud.rows].sort((a, b) => a.bag - b.bag).map(r => (
          <div key={r.slot} style={{ display: "flex", gap: 8, alignItems: "center", padding: "2px 0", color: r.holder ? "#ff6b86" : "#fff" }}>
            <span style={{ width: 10, height: 10, borderRadius: 5, background: SLOT_COLORS[r.slot % SLOT_COLORS.length], display: "inline-block" }} />
            <span style={{ flex: 1 }}>{r.you ? "YOU" : r.name}{r.holder ? " 💰" : ""}{r.frozen ? " 🕸" : ""}</span>
            <span data-testid={`tag-bag-${r.slot}`}>{r.bag.toFixed(1)}s</span>
          </div>
        ))}
        <div style={{ fontSize: 10, opacity: 0.7, marginTop: 4 }}>bag time · lowest wins</div>
      </div>
      {cd > 0 && <div style={{ position: "absolute", top: "38%", width: "100%", textAlign: "center", fontSize: 72, fontWeight: 900, textShadow: "0 3px 6px #000" }}>{cd}</div>}
      {showFlash && (
        <div style={{ position: "absolute", top: "28%", width: "100%", textAlign: "center", opacity: Math.min(1, (1800 - (now - flashS!.t)) / 400) }} data-testid="tag-flash">
          <div style={{ fontSize: 44, fontWeight: 900, color: flashS!.color, textShadow: "0 3px 6px #000, 3px 3px 0 rgba(0,0,0,0.5)" }}>{flashS!.text}</div>
          {flashS!.sub && <div style={{ fontSize: 16, textShadow: "0 1px 3px #000" }}>{flashS!.sub}</div>}
        </div>
      )}
      {you && hud.frozen > 0 && hud.phase !== PH_OVER && (
        <div style={{ position: "absolute", top: "58%", width: "100%", textAlign: "center", fontSize: 18, color: "#f4f7ff", textShadow: "0 1px 3px #000" }}>web-tangled · {hud.frozen.toFixed(1)}</div>
      )}
      {you && hud.lock > 0 && <div style={{ position: "absolute", top: "58%", width: "100%", textAlign: "center", fontSize: 18, textShadow: "0 1px 3px #000" }}>back on your feet · {hud.lock.toFixed(1)}</div>}
      <div id="rr-tag-arrow" style={{ position: "absolute", left: 0, top: 0, visibility: "hidden" }}>
        <div style={{ width: 0, height: 0, borderTop: "14px solid transparent", borderBottom: "14px solid transparent", borderLeft: `26px solid ${holding ? "#ffd23f" : "#ff3355"}`, filter: "drop-shadow(0 1px 2px #000)" }} />
      </div>
      {Array.from({ length: MAX_TAGS }, (_, i) => (
        <div key={i} id={`rr-tag-${i}`} style={{ position: "absolute", left: 0, top: 0, visibility: "hidden", whiteSpace: "nowrap", fontSize: 12, background: "rgba(14,16,30,0.6)", padding: "1px 6px", borderRadius: 4, borderBottom: `2px solid ${SLOT_COLORS[i]}` }} data-radbro={slots[i]} />
      ))}
    </div>
  );
}

function Results({ onRematch, onMenu }: { onRematch: () => void; onMenu: () => void }) {
  const hud = useTag(s => s.hud);
  const agreed = useTag(s => s.agreed);
  if (!hud) return null;
  const rows = [...hud.rows].sort((a, b) => a.bag - b.bag || a.falls - b.falls || b.tags - a.tags || a.slot - b.slot);
  const win = rows[0];
  return (
    <div style={{ ...layer, display: "grid", placeItems: "center", background: "rgba(10,12,30,0.35)" }} data-testid="tag-results">
      <div style={{ ...panel, minWidth: 300, textAlign: "center" }}>
        <div style={{ font: "900 34px ui-monospace, monospace", color: win.you ? "#8dff8a" : "#ffd23f", textShadow: "3px 3px 0 rgba(0,0,0,0.4)" }}>{win.you ? "YOU WIN" : `${win.name} WINS`}</div>
        <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>least time holding the bag</div>
        <table style={{ margin: "0 auto", borderCollapse: "collapse", fontSize: 14 }}>
          <thead><tr style={{ opacity: 0.7, fontSize: 11 }}><td /><td style={{ padding: "0 10px" }}>bag</td><td style={{ padding: "0 10px" }}>tags</td><td style={{ padding: "0 10px" }}>falls</td></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.slot} style={{ color: r.you ? "#ffd23f" : "#fff" }}>
                <td style={{ textAlign: "left", padding: "2px 10px 2px 0" }}>{i + 1}. {r.you ? "YOU" : r.name}</td>
                <td style={{ padding: "0 10px" }}>{r.bag.toFixed(1)}s</td>
                <td style={{ padding: "0 10px" }}>{r.tags}</td>
                <td style={{ padding: "0 10px" }}>{r.falls}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {agreed !== null && <div style={{ fontSize: 11, marginTop: 8, color: agreed ? "#8dff8a" : "#ff8a8a" }} data-testid="tag-agreed">{agreed ? "both players' results match" : "results differ between players (desync)"}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 14 }}>
          <button style={btn(true)} onClick={onRematch} data-testid="tag-rematch">REMATCH</button>
          <button style={btn(false)} onClick={onMenu} data-testid="tag-menu-btn">MENU</button>
        </div>
      </div>
    </div>
  );
}

function Loading() {
  const load = useTag(s => s.load);
  return (
    <div style={{ ...layer, display: "grid", placeItems: "center", background: "rgba(10,12,30,0.5)" }}>
      <div style={{ ...panel, minWidth: 260, textAlign: "center" }}>
        <div style={{ fontWeight: 800, letterSpacing: 3 }}>LOADING</div>
        <div style={{ height: 8, background: "rgba(255,255,255,0.15)", borderRadius: 4, marginTop: 10 }}>
          <div style={{ height: 8, width: `${Math.round(load.progress * 100)}%`, background: "#ff3d7f", borderRadius: 4 }} />
        </div>
        {load.error && <div style={{ color: "#ff8a8a", fontSize: 12, marginTop: 8 }}>failed to load {load.error}</div>}
      </div>
    </div>
  );
}

function PauseOverlay({ onResume, onQuit }: { onResume: () => void; onQuit: () => void }) {
  return (
    <div style={{ ...layer, display: "grid", placeItems: "center", background: "rgba(10,12,30,0.5)" }}>
      <div style={{ ...panel, textAlign: "center", minWidth: 240 }}>
        <div style={{ fontWeight: 900, letterSpacing: 3, marginBottom: 12 }}>PAUSED</div>
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button style={btn(true)} onClick={onResume}>RESUME</button>
          <button style={btn(false)} onClick={onQuit}>QUIT</button>
        </div>
      </div>
    </div>
  );
}

const canvasEl = () => document.querySelector("canvas");

/** Bot opponents: the other Radbros first (seeded), duplicates only past the roster. */
function botRadbros(you: RadbroId, n: number, seed: number): RadbroId[] {
  const rng = new Rand(seed ^ 0x7a6);
  const pool = RADBROS.filter(r => r !== you);
  const out: RadbroId[] = [];
  while (out.length < n) {
    const left = pool.filter(p => !out.includes(p));
    const from = left.length ? left : RADBROS;
    out.push(from[Math.floor(rng.next() * from.length)]);
  }
  return out;
}

export default function TagPage() {
  const [game, setGame] = useState<TagGame | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const screen = useTag(s => s.screen);
  const ready = useUi(s => s.sceneReady);
  const touch = useUi(s => s.touch);
  const [radbro, setRadbro] = useState<RadbroId>(() => { try { return (JSON.parse(localStorage.getItem("rugrun.tag") ?? "{}").radbro as RadbroId) || "652"; } catch { return "652"; } });
  const [bots, setBots] = useState(() => { try { return Number(JSON.parse(localStorage.getItem("rugrun.tag") ?? "{}").bots) || 1; } catch { return 1; } });
  const [level, setLevel] = useState<BotLevel>(() => { try { return (JSON.parse(localStorage.getItem("rugrun.tag") ?? "{}").level as BotLevel) || "normal"; } catch { return "normal"; } });
  const [paused, setPaused] = useState(false);
  const [online, setOnline] = useState(!!ROOM);
  useEffect(() => { try { localStorage.setItem("rugrun.tag", JSON.stringify({ radbro, bots, level })); } catch { /* private mode */ } }, [radbro, bots, level]);

  useEffect(() => {
    bootTag().then(g => {
      const s = loadSettings(g.camera);
      applySettings(g.camera, s);
      setAudioVolumes(s.music, s.sfx, s.voice);
      setMuted(s.muted);
      g.autoLevel = AUTO;
      g.retune();
      setGame(g);
    }, e => setErr(String(e)));
  }, []);
  useEffect(() => { game?.setTouch(touch); }, [game, touch]);
  useEffect(() => { if (game && ready && screen === "boot") useTag.setState({ screen: online ? "online" : "menu" }); }, [game, ready, screen, online]);
  useEffect(() => { const onTouch = () => { if (!useUi.getState().touch) useUi.setState({ touch: true }); }; addEventListener("touchstart", onTouch, { passive: true }); return () => removeEventListener("touchstart", onTouch); }, []);

  const lock = useCallback(() => { if (!useUi.getState().touch && !AUTO) requestLock(canvasEl()); }, []);

  const play = useCallback(async (seed = randomSeed()) => {
    if (!game) return;
    unlockAudio();
    preloadSfx();
    const others = botRadbros(radbro, bots, seed);
    const ids = [radbro, ...others];
    useTag.setState({ screen: "loading", flash: null, agreed: null });
    if (!(await loadRadbros(ids))) return;
    const slots: TagSlot[] = ids.map((r, i) => ({ radbro: r, touch: i === 0 && game.touch, easy: i === 0 && game.camera.easyGrab, name: i === 0 ? "you" : `#${r}` }));
    useTag.setState({ slots: ids, names: ids.map((r, i) => (i === 0 ? "YOU" : `#${r}`)) });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    game.startOffline({ slots, seed, seconds: SECS ?? TAG.seconds1v1, bots: level });
    setPaused(false);
    useTag.setState({ screen: "match" });
    lock();
  }, [game, radbro, bots, level, lock]);

  const toMenu = useCallback(() => {
    if (!game) return;
    if (game.link) useTag.getState().net?.leave();
    game.toMenu();
    document.exitPointerLock?.();
    setPaused(false);
    setOnline(false);
    useTag.setState({ screen: "menu", hud: null, flash: null, agreed: null });
  }, [game]);

  const rematch = useCallback(() => {
    if (!game) return;
    if (game.link) { useTag.getState().net?.rematch(); return; }
    void play();
  }, [game, play]);

  // Input, pointer lock, pause (offline), R = rematch at the results.
  useEffect(() => {
    if (!game) return;
    const el = canvasEl() ?? document.body;
    const detach = attachDom(game.input, el, locked => {
      if (!locked && !AUTO && !game.link && useTag.getState().screen === "match" && !game.match?.over) { game.paused = true; setPaused(true); }
      if (locked) { game.paused = false; setPaused(false); }
    });
    const click = () => { if (useTag.getState().screen === "match" && !useUi.getState().touch && document.pointerLockElement !== el) requestLock(el); };
    const kd = (e: KeyboardEvent) => { if (e.code === "KeyR" && !e.repeat && useTag.getState().screen === "results") rematch(); };
    el.addEventListener("click", click);
    addEventListener("keydown", kd);
    return () => { detach(); el.removeEventListener("click", click); removeEventListener("keydown", kd); };
  }, [game, rematch]);

  if (err) return <div style={{ padding: 20 }}>Failed to load: {err}</div>;
  if (!game) return <div style={{ padding: 20, height: "100%", boxSizing: "border-box", background: "#9fc3e6 url(/ui/key-art.webp) center / cover no-repeat" }}>loading…</div>;
  const inMatch = screen === "match";
  return (
    <>
      <TagScene game={game} />
      {screen === "menu" && <Menu radbro={radbro} setRadbro={setRadbro} bots={bots} setBots={setBots} level={level} setLevel={setLevel} ready={ready} onPlay={() => void play()} onOnline={() => { setOnline(true); useTag.setState({ screen: "online" }); }} />}
      {screen === "loading" && <Loading />}
      {(inMatch || screen === "results") && <Hud />}
      {screen === "results" && <Results onRematch={rematch} onMenu={toMenu} />}
      {touch && inMatch && !paused && !AUTO && <TouchControls input={game.input} onPause={() => { if (!game.link) { game.paused = true; setPaused(true); } }} />}
      {online && (
        <Suspense fallback={screen === "online" ? <div style={{ ...layer, display: "grid", placeItems: "center" }}><div style={panel}>loading online…</div></div> : null}>
          <Online game={game} radbro={radbro} setRadbro={setRadbro} room={ROOM} district={PAGE_DISTRICT} onExit={toMenu} />
        </Suspense>
      )}
      {paused && inMatch && <PauseOverlay onResume={() => (touch ? (game.paused = false, setPaused(false)) : requestLock(canvasEl()))} onQuit={toMenu} />}
    </>
  );
}
