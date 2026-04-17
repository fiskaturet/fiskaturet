import { useState, useRef, useCallback } from "react";

// ── DrumMachine ──
// Nordic-minimal DAW-inspired drum sequencer
// Receives all state + callbacks as props from App.jsx

export default function DrumMachine({
  // Data
  drumPattern, drumGenre, DRUM_GENRES, DRUM_TRACKS, DRUM_STEPS, DRUM_BAR_STEPS,
  lockedTracks, mutedTracks, soloTrack, tripletTracks,
  drumSwing, drumHalfTime, drumFavorites, padMap, drumStep,
  densityDrums, densitySeed, looping, loopEnabled,
  timelineItems, bassLine,
  // Density functions
  densityPass, drumImportance,
  // Actions
  setDrumGenre, setDrumPattern, setLockedTracks, setMutedTracks,
  setSoloTrack, setTripletTracks, setDrumSwing, setDrumHalfTime,
  setDrumFavorites, setDensityDrums, setLoopEnabled,
  generateDrumPattern, toggleDrumStep, playTimeline, stopLoop,
  setPadMapperOpen,
  // Pad mapper
  PAD_MAP_PRESETS, MPC_PADS, padMapperOpen,
  midiToPadLabel, padLabelToMidi, setPadMap,
}) {
  const [hoveredTrack, setHoveredTrack] = useState(null);
  const [hoveredStep, setHoveredStep] = useState(null);

  const hasContent = drumPattern || timelineItems.length > 0 || bassLine.length > 0;
  const canPlay = !!drumPattern || timelineItems.length > 0 || bassLine.length > 0;

  return (
    <div className="w-full select-none">

      {/* ── Header: Genre + Transport ── */}
      <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
        {/* Left: Genre selector */}
        <div className="flex items-center gap-3">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
            Pattern
          </label>
          <select
            value={drumGenre}
            onChange={e => setDrumGenre(e.target.value)}
            className="bg-surface-2 border border-border-default rounded-lg px-3 py-2 text-sm font-medium text-text-primary cursor-pointer hover:border-border-strong transition-colors duration-100 focus:outline-none focus:ring-1 focus:ring-accent/40 min-w-[200px]"
          >
            {Object.entries(DRUM_GENRES).map(([k, g]) => (
              <option key={k} value={k}>{g.label} · {g.bpm}</option>
            ))}
          </select>
        </div>

        {/* Right: Transport */}
        <div className="flex items-center gap-2">
          <button
            onClick={generateDrumPattern}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-accent text-surface-0 hover:bg-accent-strong transition-colors duration-100 active:scale-[0.97]"
          >
            Generate
          </button>
          <button
            onClick={() => {
              if (drumPattern) {
                const genre = DRUM_GENRES[drumGenre];
                if (genre) {
                  const fresh = genre.generate();
                  Object.keys(lockedTracks).forEach(tid => {
                    if (lockedTracks[tid] && drumPattern[tid]) fresh[tid] = drumPattern[tid];
                  });
                  DRUM_TRACKS.forEach(tr => { if (!fresh[tr.id]) fresh[tr.id] = new Array(DRUM_STEPS).fill(0); });
                  setDrumPattern(fresh);
                }
              }
            }}
            disabled={!drumPattern}
            className="px-4 py-2 rounded-lg text-sm font-medium border border-border-default text-text-secondary bg-surface-2 hover:bg-surface-3 hover:text-text-primary hover:border-border-strong transition-all duration-100 disabled:opacity-30 disabled:cursor-not-allowed active:scale-[0.97]"
          >
            Reroll
          </button>

          <div className="w-px h-6 bg-border-subtle mx-1" />

          <button
            onClick={playTimeline}
            disabled={!canPlay}
            className={`px-5 py-2 rounded-lg text-sm font-bold transition-all duration-150 active:scale-[0.96] ${
              looping
                ? "bg-mute-red text-white shadow-[0_0_16px_rgba(229,83,75,0.25)]"
                : canPlay
                  ? "bg-success text-surface-0 shadow-[0_0_16px_rgba(63,185,80,0.2)]"
                  : "bg-surface-3 text-text-tertiary cursor-not-allowed"
            }`}
          >
            {looping ? "Stop" : "Play"}
          </button>

          <button
            onClick={() => setLoopEnabled(e => !e)}
            className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-all duration-100 ${
              loopEnabled
                ? "border-success/40 bg-success/10 text-success"
                : "border-border-default bg-surface-2 text-text-tertiary"
            }`}
          >
            {loopEnabled ? "∞ Loop" : "1×"}
          </button>

          <div className="w-px h-6 bg-border-subtle mx-1" />

          <button
            onClick={() => setPadMapperOpen(true)}
            className="px-3 py-2 rounded-lg text-xs font-medium border border-border-default text-text-tertiary bg-surface-2 hover:bg-surface-3 hover:text-text-secondary transition-all duration-100"
          >
            Pad Map
          </button>
          <button
            onClick={() => { stopLoop(); setDrumPattern(null); setLockedTracks({}); setMutedTracks({}); setSoloTrack(null); }}
            className="px-3 py-2 rounded-lg text-xs font-medium border border-border-default text-text-tertiary bg-surface-2 hover:bg-surface-3 hover:text-mute-red transition-all duration-100"
          >
            Clear
          </button>
        </div>
      </div>

      {/* ── Parameter Strip ── */}
      <div className="flex items-center gap-6 mb-4 px-1 flex-wrap">
        {/* Density */}
        <ParamSlider label="Density" value={densityDrums} onChange={setDensityDrums}
          active={densityDrums < 100} color="accent" />
        {/* Swing */}
        <ParamSlider label="Swing" value={drumSwing} onChange={setDrumSwing}
          active={drumSwing > 0} color="accent" />
        {/* Half-time */}
        <button
          onClick={() => setDrumHalfTime(h => !h)}
          className={`px-3 py-1.5 rounded-md text-xs font-semibold border transition-all duration-100 ${
            drumHalfTime
              ? "border-accent/50 bg-accent-muted text-accent"
              : "border-border-default bg-transparent text-text-tertiary hover:text-text-secondary hover:border-border-strong"
          }`}
        >
          ½ Half
        </button>

        <div className="w-px h-5 bg-border-subtle" />

        {/* Favorites */}
        {drumPattern && (
          <button
            onClick={() => {
              const id = Date.now();
              const label = `${DRUM_GENRES[drumGenre]?.label || drumGenre} #${drumFavorites.length + 1}`;
              setDrumFavorites(f => [...f, { id, genre: drumGenre, pattern: JSON.parse(JSON.stringify(drumPattern)), label }]);
            }}
            className="px-3 py-1.5 rounded-md text-xs font-medium border border-border-default text-text-tertiary hover:text-solo-amber hover:border-solo-amber/40 transition-all duration-100"
          >
            ★ Save
          </button>
        )}
        {drumFavorites.length > 0 && (
          <select
            value=""
            onChange={e => {
              const fav = drumFavorites.find(f => String(f.id) === e.target.value);
              if (fav) { stopLoop(); setDrumPattern(JSON.parse(JSON.stringify(fav.pattern))); setDrumGenre(fav.genre); }
            }}
            className="bg-surface-2 border border-border-default rounded-md px-2 py-1.5 text-xs text-text-secondary cursor-pointer hover:border-border-strong transition-colors focus:outline-none"
          >
            <option value="" disabled>Saved ({drumFavorites.length})</option>
            {drumFavorites.map(f => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </select>
        )}
      </div>

      {/* ── Step Grid ── */}
      {drumPattern ? (
        <div className="rounded-xl border border-border-default bg-surface-1 overflow-hidden">
          {/* Bar header */}
          <div className="grid" style={{ gridTemplateColumns: "160px 1fr" }}>
            <div className="px-3 py-2 border-r border-border-subtle">
              <span className="text-[9px] font-bold uppercase tracking-[0.1em] text-text-tertiary">
                Track
              </span>
            </div>
            <div className="grid grid-cols-4">
              {[1, 2, 3, 4].map(bar => (
                <div key={bar} className={`px-3 py-2 ${bar > 1 ? "border-l border-border-subtle" : ""}`}>
                  <span className="text-[9px] font-bold uppercase tracking-[0.1em] text-text-tertiary">
                    {bar}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Track rows */}
          {DRUM_TRACKS.map(track => {
            const hasHits = drumPattern[track.id]?.some(v => v > 0);
            const isMuted = !!mutedTracks[track.id];
            const isLocked = !!lockedTracks[track.id];
            const isSolo = soloTrack === track.id;
            const isTriplet = !!tripletTracks[track.id];
            const dimmed = soloTrack && !isSolo;
            const isHovered = hoveredTrack === track.id;
            const showTripletBtn = ["hatC", "hatO", "ride", "shaker"].includes(track.id);

            return (
              <div
                key={track.id}
                className="grid border-t border-border-subtle transition-opacity duration-150"
                style={{
                  gridTemplateColumns: "160px 1fr",
                  opacity: dimmed ? 0.15 : isMuted ? 0.3 : 1,
                }}
                onMouseEnter={() => setHoveredTrack(track.id)}
                onMouseLeave={() => setHoveredTrack(null)}
              >
                {/* Label cell */}
                <div className="flex items-center gap-1 px-2 py-0.5 border-r border-border-subtle bg-surface-1">
                  {/* Lock */}
                  <button
                    onClick={() => setLockedTracks(p => ({ ...p, [track.id]: !p[track.id] }))}
                    className={`w-5 h-5 flex items-center justify-center rounded text-[10px] transition-all duration-100 hover:bg-surface-3 ${
                      isLocked ? "text-lock-blue opacity-100" : "text-text-tertiary opacity-30 hover:opacity-60"
                    }`}
                    title={isLocked ? "Unlock" : "Lock (preserves on regenerate)"}
                  >
                    {isLocked ? "●" : "○"}
                  </button>
                  {/* Mute */}
                  <button
                    onClick={() => setMutedTracks(p => ({ ...p, [track.id]: !p[track.id] }))}
                    className={`w-5 h-5 flex items-center justify-center rounded text-[9px] font-bold transition-all duration-100 hover:bg-surface-3 ${
                      isMuted ? "text-mute-red opacity-100" : "text-text-tertiary opacity-40 hover:opacity-70"
                    }`}
                    title={isMuted ? "Unmute" : "Mute"}
                  >
                    M
                  </button>
                  {/* Solo */}
                  <button
                    onClick={() => setSoloTrack(s => s === track.id ? null : track.id)}
                    className={`w-5 h-5 flex items-center justify-center rounded text-[9px] font-bold transition-all duration-100 hover:bg-surface-3 ${
                      isSolo ? "text-solo-amber opacity-100" : "text-text-tertiary opacity-40 hover:opacity-70"
                    }`}
                    title={isSolo ? "Unsolo" : "Solo"}
                  >
                    S
                  </button>
                  {/* Triplet */}
                  {showTripletBtn && (
                    <button
                      onClick={() => setTripletTracks(p => ({ ...p, [track.id]: !p[track.id] }))}
                      className={`w-5 h-5 flex items-center justify-center rounded text-[9px] font-bold transition-all duration-100 hover:bg-surface-3 ${
                        isTriplet ? "text-triplet-violet opacity-100" : "text-text-tertiary opacity-30 hover:opacity-60"
                      }`}
                      title={isTriplet ? "16th grid" : "Triplet grid"}
                    >
                      3
                    </button>
                  )}
                  {/* Track name */}
                  <span className={`ml-1 text-[11px] font-medium truncate flex-1 transition-colors duration-100 ${
                    hasHits ? "text-text-primary" : "text-text-tertiary"
                  }`}>
                    {track.label}
                  </span>
                </div>

                {/* Step cells */}
                <div className="grid bg-surface-1" style={{ gridTemplateColumns: `repeat(${DRUM_STEPS}, 1fr)` }}>
                  {drumPattern[track.id].map((vel, step) => {
                    const isPlayhead = drumStep === step && looping;
                    const isBeat = step > 0 && step % 4 === 0;
                    const isBar = step > 0 && step % DRUM_BAR_STEPS === 0;
                    const isOdd = step % 2 === 1;
                    const swingPx = isOdd && drumSwing > 0 ? Math.round(drumSwing / 100 * 5) : 0;
                    const densityRemoved = vel > 0 && densityDrums < 100 &&
                      !densityPass(densitySeed, track.id, step, densityDrums, drumImportance(track.id, step));
                    const velNorm = vel / 127; // 0..1

                    return (
                      <div
                        key={step}
                        onClick={() => toggleDrumStep(track.id, step)}
                        onMouseEnter={() => setHoveredStep(step)}
                        onMouseLeave={() => setHoveredStep(null)}
                        className="relative cursor-pointer group"
                        style={{
                          height: 26,
                          borderLeft: isBar ? "1.5px solid rgba(255,255,255,0.08)" : isBeat ? "0.5px solid rgba(255,255,255,0.04)" : "none",
                          background: isPlayhead ? "var(--color-playhead)" : "transparent",
                        }}
                      >
                        {/* Background stripe for odd columns */}
                        {isOdd && !vel && (
                          <div className="absolute inset-0 bg-white/[0.01]" />
                        )}

                        {/* Hover indicator */}
                        {!vel && (
                          <div className="absolute inset-x-0 top-1 bottom-1 rounded-[2px] bg-white/[0.03] opacity-0 group-hover:opacity-100 transition-opacity duration-75" />
                        )}

                        {/* Hit cell — velocity shown as height */}
                        {vel > 0 && (
                          <div
                            className="absolute bottom-0 left-0 right-0 rounded-t-[2px] transition-all duration-100"
                            style={{
                              height: densityRemoved
                                ? "2px"
                                : `${Math.max(20, velNorm * 100)}%`,
                              marginLeft: swingPx,
                              marginRight: Math.max(0, 1 - swingPx),
                              background: densityRemoved
                                ? "rgba(255,255,255,0.06)"
                                : `rgba(196, 138, 90, ${velNorm * 0.7 + 0.3})`,
                              borderTop: densityRemoved
                                ? "1px dashed rgba(255,255,255,0.1)"
                                : "none",
                              opacity: densityRemoved ? 0.5 : 1,
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* ── Empty state ── */
        <div className="rounded-xl border border-border-default border-dashed bg-surface-1 py-16 px-8 text-center">
          <p className="text-sm text-text-tertiary mb-4">
            Select a genre and press <span className="text-text-secondary font-medium">Generate</span> to create a pattern
          </p>
          <button
            onClick={generateDrumPattern}
            className="px-5 py-2.5 rounded-lg text-sm font-semibold bg-accent text-surface-0 hover:bg-accent-strong transition-colors duration-100 active:scale-[0.97]"
          >
            Generate Pattern
          </button>
        </div>
      )}

      {/* ── Pad Mapper Modal ── */}
      {padMapperOpen && (
        <>
          <div
            onClick={() => setPadMapperOpen(false)}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100]"
          />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[101] w-[420px] max-h-[90vh] overflow-auto bg-surface-2 rounded-2xl border border-border-default shadow-[0_24px_64px_rgba(0,0,0,0.5)] p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-base font-bold text-text-primary font-display tracking-tight">Pad Mapping</h3>
              <button
                onClick={() => setPadMapperOpen(false)}
                className="w-7 h-7 flex items-center justify-center rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface-3 transition-colors"
              >
                ✕
              </button>
            </div>

            {/* Presets */}
            <div className="flex gap-2 flex-wrap mb-4">
              {PAD_MAP_PRESETS.map(preset => {
                const isActive = DRUM_TRACKS.every(tr => padMap[tr.id]?.midiNote === preset.map[tr.id]?.midiNote);
                return (
                  <button
                    key={preset.id}
                    onClick={() => setPadMap({ ...preset.map })}
                    className={`px-3 py-1.5 rounded-md text-xs font-semibold border transition-all duration-100 ${
                      isActive
                        ? "border-success/50 bg-success/10 text-success"
                        : "border-border-default bg-surface-3 text-text-secondary hover:text-text-primary hover:border-border-strong"
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>

            {/* Pad list */}
            <div className="flex flex-col gap-1">
              {DRUM_TRACKS.map(track => {
                const mapping = padMap[track.id];
                const currentPadLabel = midiToPadLabel(mapping.midiNote);
                return (
                  <div key={track.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-3/50 border border-border-subtle">
                    <span className="text-xs font-semibold text-accent w-[70px] shrink-0">{track.label}</span>
                    <span className="text-[10px] text-text-tertiary">→</span>
                    <select
                      value={currentPadLabel}
                      onChange={e => {
                        const midi = padLabelToMidi(e.target.value);
                        setPadMap(p => ({ ...p, [track.id]: { padId: e.target.value, midiNote: midi } }));
                      }}
                      className="font-mono text-sm font-bold px-2 py-1 rounded-md border border-border-default bg-surface-2 text-text-primary cursor-pointer w-[64px] focus:outline-none focus:ring-1 focus:ring-accent/30"
                    >
                      {MPC_PADS.map(pad => (
                        <option key={pad.label} value={pad.label}>{pad.label}</option>
                      ))}
                    </select>
                    <span className="text-[10px] font-mono text-text-tertiary opacity-50">{mapping.midiNote}</span>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setPadMapperOpen(false)}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-accent text-surface-0 hover:bg-accent-strong transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Param slider sub-component ──
function ParamSlider({ label, value, onChange, active, color = "accent", min = 0, max = 100 }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={`text-[10px] font-semibold uppercase tracking-[0.08em] transition-colors duration-150 ${
        active ? "text-accent" : "text-text-tertiary"
      }`}>
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-24"
      />
      <span className={`text-[11px] font-mono w-8 text-right transition-colors duration-150 ${
        active ? "text-accent" : "text-text-tertiary"
      }`}>
        {value}%
      </span>
    </div>
  );
}
