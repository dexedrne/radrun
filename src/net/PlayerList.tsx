import { create } from 'zustand';
import { btn, panel, scroller } from '../ui/screens.tsx';

export const usePlayerMutes = create<{ ids: Record<string, boolean>; toggle(id: string): void }>(set => ({ ids: {},
  toggle: id => set(s => ({ ids: { ...s.ids, [id.toLowerCase()]: !s.ids[id.toLowerCase()] } })) }));
export const playerName = (id: string, name: string) => usePlayerMutes.getState().ids[id.toLowerCase()] ? 'Muted player' : name;

export function PlayerList({ players, onReport, onBack, notice }: { players: { id: string; name: string }[]; onReport(id: string): void; onBack(): void; notice?: string }) {
  const m = usePlayerMutes();
  return <div data-pad-modal data-player-list style={{ ...scroller, zIndex: 55, background: '#080a14f5' }}>
    <div style={{ ...panel, maxWidth: 560, margin: 'auto' }}><h2>PLAYERS</h2><p>A mute / unmute · X report · B back</p>
      {players.map((p, i) => <div key={p.id} data-player-row style={{ margin: '10px 0', display: 'flex', gap: 10, alignItems: 'center' }}>
        <span style={{ flex: 1 }}>{playerName(p.id, p.name)}</span>
        <button data-pad-cycle data-pad-default={i === 0 ? '' : undefined} aria-pressed={!!m.ids[p.id.toLowerCase()]} style={btn(false)} onClick={() => m.toggle(p.id)}>{m.ids[p.id.toLowerCase()] ? 'UNMUTE' : 'MUTE'}</button>
        <button data-player-report data-pad-skip style={btn(false)} onClick={() => onReport(p.id)}>REPORT</button>
      </div>)}
      {!players.length && <p>No other players here.</p>}{notice && <p role="status">{notice}</p>}
      <button data-pad-btn="EAST" style={btn(false)} onClick={onBack}>BACK</button>
    </div>
  </div>;
}
