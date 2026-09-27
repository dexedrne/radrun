// ONLINE (the lazy net chunk, loaded only when ONLINE is pressed or a room link is opened): the lobby for 1v1 private
// rooms (CREATE gives a code + a link, JOIN takes a code; pick a Radbro; READY), then the match through the relay with
// rollback (net/session.ts) and the results agreement. Stays mounted during the match to keep the socket, and says
// what it is waiting for (the other player's inputs, a rematch, a player who left); a match that waits on the other
// player for GIVE_UP_MS is abandoned (the socket closes, so the relay tells him too).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TagGame } from "../game/tagGame.ts";
import { TAG } from "../game/tagMatch.ts";
import { RADBROS, isRadbroId, type RadbroId } from "../game/radbros.ts";
import { Fnv1a } from "../sim/math.ts";
import type { Tuning } from "../sim/tuning.ts";
import { DISTRICTS, isDistrictId, type DistrictId } from "../world/districts.ts";
import { LINK_VERSION } from "../ui/prefs.ts";
import { btn, panel, scroller } from "../ui/screens.tsx";
import { RADBRO_COLOR } from "../ui/strings.ts";
import { gotoDistrict } from "../app/district.ts";
import { loadRadbros, useTag } from "../app/TagPage.tsx";
import { BUILD_ID } from "./build.ts";
import { OnlineSession } from "./session.ts";
import { SELFTEST_HASH, selfTestHash } from "./selftest.ts";
import { Transport, createRoom, relayBase } from "./transport.ts";
import { CODE_ALPHABET, CODE_LEN, NET_VERSION, cleanName, isRoomCode, type Compat, type PlayerInfo, type RoomConfig, type ServerMsg, type StartMsg } from "./wire.ts";

const DEV = import.meta.env.MODE !== "production";
const params = new URLSearchParams(location.search);
/** Dev / test: ?secs=N sets the room's match length (host), ?lag=N asks the local relay for N ms RTT, ?autoready. */
const SECS = DEV && params.has("secs") ? Number(params.get("secs")) : null;
const LAG = DEV ? Number(params.get("lag") ?? 0) || 0 : 0;
const AUTOREADY = DEV && params.has("autoready");
const AUTOCREATE = DEV && params.has("autocreate");
/** A match waiting this long (ms) on the other player's inputs is abandoned. */
const GIVE_UP_MS = 30_000;

/** The match rules both clients must share: every player tuning key and the tag table. */
function tuningHash(t: Tuning): string {
  const h = new Fnv1a();
  const put = (o: Record<string, unknown>) => {
    for (const k of Object.keys(o).sort()) {
      const v = o[k];
      h.str(k);
      if (typeof v === "number") h.f64(v); else if (typeof v === "boolean") h.i32(v ? 1 : 0);
    }
  };
  put(t as unknown as Record<string, unknown>);
  put(TAG as unknown as Record<string, unknown>);
  return h.hex();
}

type Phase = "home" | "connecting" | "lobby" | "loading" | "match" | "error";

declare global {
  interface Window {
    __room?: {
      code: string; slot: number; phase: string; players: number; desyncs: number; rtt: number; inputDelay: number; stalls: number; rollbacks: number; p99: number; sent: number; recv: number;
      inputs: number; waitMs: number; maxWaitMs: number; behind: number; maxBehind: number; status: string;
    };
  }
}

export default function Online(props: { game: TagGame; radbro: RadbroId; setRadbro: (r: RadbroId) => void; room: string | null; district: DistrictId; onExit: () => void }) {
  const { game } = props;
  const base = useMemo(() => relayBase(), []);
  const [phase, setPhase] = useState<Phase>("home");
  const [err, setErr] = useState("");
  const [code, setCode] = useState(props.room && isRoomCode(props.room.toUpperCase()) ? props.room.toUpperCase() : "");
  const [joinCode, setJoinCode] = useState("");
  const [players, setPlayers] = useState<PlayerInfo[]>([]);
  const [config, setConfig] = useState<RoomConfig | null>(null);
  const [slot, setSlot] = useState(-1);
  const [ready, setReady] = useState(false);
  const [copied, setCopied] = useState(false);
  const tRef = useRef<Transport | null>(null);
  const sRef = useRef<OnlineSession | null>(null);
  const slotRef = useRef(-1);
  const playersRef = useRef<PlayerInfo[]>([]);
  const readyRef = useRef(false);
  const screen = useTag(s => s.screen);
  const selfOk = useMemo(() => selfTestHash() === SELFTEST_HASH, []);

  const compat = useCallback((): Compat => ({ v: NET_VERSION, build: BUILD_ID, link: LINK_VERSION, city: game.model.hash, tuning: tuningHash(game.tuning) }), [game]);

  const leave = useCallback(() => {
    tRef.current?.close();
    tRef.current = null;
    sRef.current = null;
    useTag.setState({ net: null, netStatus: "", netGone: false });
  }, []);

  /** Leave the match (not the page) with a message: the socket closes, so the relay tells the other player. */
  const abandon = useCallback((why: string) => {
    leave();
    game.toMenu();
    setErr(why);
    setPhase("error");
    useTag.setState({ screen: "online", hud: null });
  }, [game, leave]);

  /** The models, then the match (the session already exists and is collecting the other player's inputs). */
  const begin = useCallback(async (s: StartMsg, session: OnlineSession) => {
    const ids = s.slots.map(p => p.radbro as RadbroId);
    setPhase("loading");
    if (useTag.getState().screen !== "match") useTag.setState({ screen: "loading", flash: null, agreed: null });
    const loaded = await loadRadbros(ids);
    if (sRef.current !== session) return; // dropped or replaced while loading
    if (!loaded) { abandon("couldn't load the Radbros"); return; }
    const local = slotRef.current;
    useTag.setState({ slots: ids, names: s.slots.map(p => (p.slot === local ? "YOU" : `#${p.radbro}`)), agreed: null, flash: null, netStatus: "", netGone: false });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (sRef.current !== session) return;
    session.rb.onFresh = () => game.fresh();
    game.startOnline(session);
    setPhase("match");
    useTag.setState({ screen: "match" });
  }, [abandon, game]);

  const onMsg = useCallback((m: ServerMsg) => {
    switch (m.t) {
      case "welcome":
        slotRef.current = m.slot;
        setSlot(m.slot);
        setCode(m.room);
        setPlayers(m.players);
        setConfig(m.config);
        setPhase("lobby");
        if (m.host && SECS && SECS !== m.config.seconds) tRef.current?.sendJson({ t: "config", seconds: SECS });
        history.replaceState(null, "", `?tag&room=${m.room}${location.search.includes("map=") ? `&map=${new URLSearchParams(location.search).get("map")}` : ""}${keepDevParams()}`);
        return;
      case "lobby": {
        setPlayers(m.players);
        playersRef.current = m.players;
        setConfig(m.config);
        // Preload everyone's Radbro while waiting (the start then only builds the match).
        void loadRadbros(m.players.map(p => p.radbro).filter(isRadbroId));
        // At the results: say what the other player did.
        if (useTag.getState().screen === "results") {
          const other = m.players.find(p => p.slot !== slotRef.current);
          const status = !other ? "the other player left the room" : readyRef.current ? "waiting for the other player…" : other.ready ? "the other player wants a rematch" : "";
          useTag.setState({ netStatus: status, netGone: !other });
        }
        return;
      }
      case "start": {
        setReady(false);
        readyRef.current = false;
        const t = tRef.current;
        if (!t) return;
        if (!m.slots.every(p => isRadbroId(p.radbro))) { abandon("the other player has a Radbro this version doesn't know: both of you reload"); return; }
        // Build the session now, before the models load: the other player's inputs that arrive meanwhile (a slow load,
        // this tab hidden) queue in its rollback, and the last match's session stops receiving at once.
        const session = new OnlineSession({ model: game.model, index: game.index, tuning: game.tuning, start: m, local: slotRef.current, transport: t });
        sRef.current = session;
        void begin(m, session);
        return;
      }
      case "drop":
        game.toMenu();
        sRef.current = null;
        setPhase("lobby");
        setErr("your opponent left the match");
        useTag.setState({ screen: "online", hud: null, netStatus: "", netGone: false });
        return;
      case "result":
        useTag.setState({ agreed: m.ok });
        return;
      case "error":
        setErr(m.message);
        setPhase("error");
        return;
    }
  }, [abandon, begin, game]);

  const connect = useCallback(async (room: string | null) => {
    if (!base) return;
    if (!selfOk) { setErr("this browser computes the game differently from the others, so it can't play online (the self-test failed)"); setPhase("error"); return; }
    setErr("");
    setPhase("connecting");
    try {
      const c = room ?? (await createRoom(base, LAG));
      const t = new Transport();
      tRef.current = t;
      t.onJson = onMsg;
      t.onBinary = b => sRef.current?.onBinary(b);
      t.onClose = why => {
        if (tRef.current !== t) return;
        tRef.current = null;
        setErr(why === "rate" || why === "bad steps" ? `the relay closed the connection (${why})` : `connection closed: ${why}`);
        setPhase("error");
        if (game.link) { game.toMenu(); useTag.setState({ screen: "online", hud: null }); }
      };
      await t.connect(base, c);
      const rematch = () => {
        // The other player left at the results: back to the room (its code / link) to wait for someone.
        if (playersRef.current.length < 2) {
          game.toMenu();
          sRef.current = null;
          setPhase("lobby");
          useTag.setState({ screen: "online", hud: null, netStatus: "", netGone: false });
          return;
        }
        t.sendJson({ t: "ready", ready: true, rtt: rttOf(t) });
        setReady(true);
        readyRef.current = true;
        useTag.setState({ netStatus: "waiting for the other player…" });
      };
      useTag.setState({ net: { rematch, leave } });
      t.sendJson({ t: "hello", compat: compat(), name: cleanName(`radbro${props.radbro}`), radbro: props.radbro, touch: game.touch, easy: game.camera.easyGrab, district: props.district });
    } catch (e) {
      setErr(String((e as Error).message ?? e));
      setPhase("error");
    }
  }, [base, compat, game, onMsg, props.district, props.radbro, selfOk, leave]);

  // A room link joins straight away; ?autocreate (dev) creates one.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (code) void connect(code);
    else if (AUTOCREATE) void connect(null);
  }, [code, connect]);
  useEffect(() => () => { tRef.current?.close(); }, []);

  // Your pick follows the menu's.
  useEffect(() => { if (phase === "lobby") tRef.current?.sendJson({ t: "pick", radbro: props.radbro }); }, [props.radbro, phase]);

  const toggleReady = useCallback(() => {
    const t = tRef.current;
    if (!t) return;
    t.sendJson({ t: "ready", ready: !ready, rtt: rttOf(t) });
    setReady(!ready);
    readyRef.current = !ready;
  }, [ready]);
  useEffect(() => {
    if (AUTOREADY && phase === "lobby" && players.length === 2 && !ready && screen !== "results") {
      const iv = setTimeout(toggleReady, 1500);
      return () => clearTimeout(iv);
    }
  }, [phase, players.length, ready, screen, toggleReady]);

  // The match watchdog (a broken session or a long wait on the other player ends it) and the probe for the headless checks.
  const worst = useRef({ wait: 0, behind: 0 });
  useEffect(() => {
    const iv = setInterval(() => {
      const s = sRef.current, t = tRef.current;
      if (s && game.link === s) {
        if (s.broken) { abandon("the match lost track of the other player's inputs, so it was stopped"); return; }
        if (s.waitMs > GIVE_UP_MS) { abandon(`the other player stopped responding for ${Math.round(GIVE_UP_MS / 1000)} s, so the match was abandoned`); return; }
        worst.current.wait = Math.max(worst.current.wait, s.waitMs);
        worst.current.behind = Math.max(worst.current.behind, s.behind);
      }
      window.__room = {
        code, slot, phase, players: players.length, desyncs: s?.desyncs ?? 0, rtt: t?.rtt ?? 0, inputDelay: s?.rb.inputDelay ?? 0, stalls: s?.rb.stalls ?? 0,
        rollbacks: s?.rb.rollbacks ?? 0, p99: s?.rb.depthQuantile(0.99) ?? 0, sent: t?.sentBytes ?? 0, recv: t?.recvBytes ?? 0,
        inputs: s?.inputsSent ?? 0, waitMs: s?.waitMs ?? 0, maxWaitMs: Math.round(worst.current.wait), behind: s?.behind ?? 0, maxBehind: worst.current.behind, status: useTag.getState().netStatus,
      };
    }, 250);
    return () => clearInterval(iv);
  }, [abandon, code, game, slot, phase, players.length]);

  const exit = () => { leave(); props.onExit(); };
  if (screen === "match" || screen === "loading") return null;
  if (screen === "results") return null;

  const wrongDistrict = config && isDistrictId(config.district) && config.district !== props.district ? config.district : null;
  const link = code ? `${location.origin}/?tag&room=${code}${wrongDistrict || props.district !== "downtown" ? `&map=${config?.district ?? props.district}` : ""}` : "";
  const box: React.CSSProperties = { ...panel, maxWidth: 560, margin: "auto", textAlign: "center" };
  return (
    <div style={{ ...scroller, background: "rgba(10,12,30,0.45)" }} data-testid="online">
      <div style={box}>
        <div style={{ font: "900 28px ui-monospace, monospace", letterSpacing: 4, textShadow: "3px 3px 0 #ff3d7f" }}>ONLINE</div>
        {!base && <div style={{ marginTop: 10 }}>Online play isn't switched on for this build yet (no relay address).</div>}
        {base && phase === "home" && (
          <>
            <div style={{ fontSize: 13, opacity: 0.85, margin: "8px 0 14px" }}>1v1 with a friend: one of you creates a room and sends the code or the link.</div>
            <button style={{ ...btn(true), fontSize: 18, padding: "10px 30px" }} onClick={() => void connect(null)} data-testid="online-create" data-pad-default="">CREATE ROOM</button>
            <div style={{ marginTop: 14, display: "flex", gap: 8, justifyContent: "center", alignItems: "center" }}>
              <input value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5))} placeholder="CODE" maxLength={CODE_LEN} data-pad-chars={CODE_ALPHABET}
                style={{ width: 110, font: "700 20px ui-monospace, monospace", letterSpacing: 4, textAlign: "center", padding: "8px", borderRadius: 8, border: "2px solid #9fe6ff", background: "rgba(0,0,0,0.3)", color: "#fff" }} data-testid="online-code" />
              <button style={{ ...btn(false), opacity: isRoomCode(joinCode) ? 1 : 0.5 }} disabled={!isRoomCode(joinCode)} onClick={() => { setCode(joinCode); void connect(joinCode); }} data-testid="online-join" data-pad-btn="START">JOIN</button>
            </div>
          </>
        )}
        {phase === "connecting" && <div style={{ margin: 16 }}>connecting to the relay…</div>}
        {phase === "error" && <div style={{ margin: 16, color: "#ff9d9d" }} data-testid="online-error">{err}</div>}
        {phase === "lobby" && config && (
          <>
            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>room code</div>
            <div style={{ font: "900 44px ui-monospace, monospace", letterSpacing: 10, color: "#ffd23f" }} data-testid="online-room">{code}</div>
            <button style={{ ...btn(false), fontSize: 12, padding: "5px 12px" }} onClick={() => { void navigator.clipboard?.writeText(link).then(() => setCopied(true), () => undefined); }}>{copied ? "link copied" : "copy invite link"}</button>
            {wrongDistrict && (
              <div style={{ marginTop: 10, color: "#ffd23f" }}>
                this room plays in {DISTRICTS[wrongDistrict].name}. <button style={{ ...btn(false), fontSize: 12, padding: "4px 10px" }} onClick={() => gotoDistrict(wrongDistrict, { tag: "1", room: code })}>go there</button>
              </div>
            )}
            <div style={{ margin: "12px 0 6px", fontSize: 12, opacity: 0.8 }}>{DISTRICTS[(isDistrictId(config.district) ? config.district : "downtown") as DistrictId].name} · {Math.round(config.seconds / 60 * 10) / 10} min · lowest bag time wins</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }} data-testid="online-players">
              {[0, 1].map(i => {
                const p = players.find(q => q.slot === i);
                return (
                  <div key={i} style={{ width: 150, padding: 8, borderRadius: 10, border: `2px solid ${p?.ready ? "#8dff8a" : "rgba(255,255,255,0.25)"}`, background: "rgba(255,255,255,0.05)" }}>
                    {p ? (
                      <>
                        <img src={`/ui/radbro${p.radbro}.webp`} alt="" width={64} height={64} style={{ borderRadius: 8, background: RADBRO_COLOR[p.radbro as RadbroId]?.body ?? "#333" }} />
                        <div style={{ fontWeight: 800 }}>{p.slot === slot ? "YOU" : `#${p.radbro}`}</div>
                        <div style={{ fontSize: 12, color: p.ready ? "#8dff8a" : "#ccc" }}>{p.ready ? "READY" : "picking…"}</div>
                      </>
                    ) : <div style={{ opacity: 0.6, padding: "30px 0" }}>waiting for a friend…</div>}
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 12, display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap" }}>
              {RADBROS.map(id => (
                <button key={id} onClick={() => props.setRadbro(id)} style={{ ...btn(false), padding: "4px 8px", fontSize: 12, borderColor: id === props.radbro ? "#ff3d7f" : "rgba(255,255,255,0.3)", background: id === props.radbro ? "rgba(255,61,127,0.3)" : "rgba(255,255,255,0.05)" }}>#{id}</button>
              ))}
            </div>
            {err && <div style={{ marginTop: 8, color: "#ffd23f", fontSize: 12 }}>{err}</div>}
            <button style={{ ...btn(!ready), marginTop: 14, fontSize: 18, padding: "10px 34px", opacity: players.length === 2 && !wrongDistrict ? 1 : 0.5 }} disabled={players.length < 2 || !!wrongDistrict} onClick={toggleReady} data-testid="online-ready" data-pad-default="" data-pad-btn="START">
              {ready ? "NOT READY" : "READY"}
            </button>
          </>
        )}
        <div style={{ marginTop: 16 }}>
          <button style={{ ...btn(false), fontSize: 12, padding: "6px 14px" }} onClick={exit} data-testid="online-back" data-pad-btn="EAST">← back</button>
        </div>
      </div>
    </div>
  );
}

/** The round trip the relay picks the input delay from. */
const rttOf = (t: Transport) => (Number.isFinite(t.minRtt) ? Math.round(t.minRtt) : 100);

/** Dev / test parameters that survive the room link rewrite. */
function keepDevParams(): string {
  if (!DEV) return "";
  const q = new URLSearchParams(location.search), out: string[] = [];
  for (const k of ["bot", "secs", "relay", "autoready", "lag"]) if (q.has(k)) out.push(`&${k}${q.get(k) ? `=${q.get(k)}` : ""}`);
  return out.join("");
}
