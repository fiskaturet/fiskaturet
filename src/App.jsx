import { useState, useRef, useCallback, useEffect } from "react";
import * as Tone from "tone";
import JSZip from "jszip";

// ═══════════════════════════════════════════════════════════════════════════
// ─── MIDI FILE WRITER (Standard MIDI File Type 1) ────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

function writeVarLen(value) {
  const bytes = [];
  bytes.push(value & 0x7F);
  value >>= 7;
  while (value > 0) {
    bytes.push((value & 0x7F) | 0x80);
    value >>= 7;
  }
  return bytes.reverse();
}

function writeInt16(v) { return [(v >> 8) & 0xFF, v & 0xFF]; }
function writeInt32(v) { return [(v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF]; }

function buildMidiTrack(events, channelNum = 0) {
  // events: [{ tick, type:"note", note, velocity, duration }, { tick, type:"meta", metaType, data }]
  // Sort by tick, then note-on before note-off at same tick
  const allEvents = [];
  events.forEach(ev => {
    if (ev.type === "note") {
      allEvents.push({ tick: ev.tick, sort: 0, bytes: [0x90 | channelNum, ev.note, ev.velocity] });
      allEvents.push({ tick: ev.tick + ev.duration, sort: 1, bytes: [0x80 | channelNum, ev.note, 0] });
    } else if (ev.type === "meta") {
      allEvents.push({ tick: ev.tick, sort: -1, bytes: [0xFF, ev.metaType, ...writeVarLen(ev.data.length), ...ev.data] });
    } else if (ev.type === "tempo") {
      const uspb = Math.round(60000000 / ev.bpm);
      allEvents.push({ tick: ev.tick, sort: -2, bytes: [0xFF, 0x51, 0x03, (uspb >> 16) & 0xFF, (uspb >> 8) & 0xFF, uspb & 0xFF] });
    }
  });
  allEvents.sort((a, b) => a.tick - b.tick || a.sort - b.sort);

  const trackData = [];
  let lastTick = 0;
  allEvents.forEach(ev => {
    const delta = ev.tick - lastTick;
    trackData.push(...writeVarLen(delta), ...ev.bytes);
    lastTick = ev.tick;
  });
  // End of track
  trackData.push(0x00, 0xFF, 0x2F, 0x00);
  return trackData;
}

function buildMidiFile(tracks, ppq = 480) {
  // tracks: array of { events, channel, name }
  const numTracks = tracks.length;
  const header = [
    0x4D, 0x54, 0x68, 0x64,              // "MThd"
    ...writeInt32(6),                      // header length
    ...writeInt16(numTracks > 1 ? 1 : 0),  // format
    ...writeInt16(numTracks),              // number of tracks
    ...writeInt16(ppq),                    // ticks per quarter note
  ];

  const trackChunks = tracks.map(t => {
    // Add track name meta event
    const nameBytes = new TextEncoder().encode(t.name || "");
    const events = [
      { tick: 0, type: "meta", metaType: 0x03, data: [...nameBytes] },
      ...t.events,
    ];
    const data = buildMidiTrack(events, t.channel || 0);
    return [
      0x4D, 0x54, 0x72, 0x6B,  // "MTrk"
      ...writeInt32(data.length),
      ...data,
    ];
  });

  const bytes = new Uint8Array([...header, ...trackChunks.flat()]);
  return bytes;
}

// Convert timeline + drums + bass to a multi-track MIDI file
function exportToMidi({ timelineItems, drumPattern, bassLine, melodyLine, bpm, chordOctave, padMap,
                        pianoRollEdits, TIMELINE_SLOTS, DRUM_TRACKS, sections, arrangement }) {
  const PPQ = 480; // ticks per quarter note
  const ticksPerSlot = PPQ / 4; // 16th note = 1/4 of a quarter

  // If arrangement mode, build from sections; otherwise use single timeline
  const resolvedSections = arrangement && arrangement.length > 0
    ? arrangement.map(secId => sections.find(s => s.id === secId)).filter(Boolean)
    : [{ timelineItems, drumPattern, bassLine, melodyLine }];

  // Tempo track
  const tempoTrack = {
    name: "Tempo",
    channel: 0,
    events: [{ tick: 0, type: "tempo", bpm }],
  };

  // Chord track
  const chordEvents = [];
  let sectionOffset = 0;
  resolvedSections.forEach(sec => {
    const items = sec.timelineItems || [];
    items.forEach(item => {
      const intervals = (CHORD_INTERVALS[item.chord.quality] || CHORD_INTERVALS["maj"]);
      let octave = chordOctave;
      let prev = -1;
      intervals.forEach(iv => {
        const ni = (item.chord.noteIdx + iv) % 12;
        if (ni < prev) octave++;
        prev = ni;
        const midi = ni + octave * 12 + 12;
        const key = `${midi}-${item.startSlot}`;
        const edit = pianoRollEdits?.[key];
        if (edit?.muted) return;
        const vel = edit?.velocity ?? 100;
        const startTick = (sectionOffset + item.startSlot) * ticksPerSlot;
        const durTicks = (edit?.lengthSlots ?? item.lengthSlots) * ticksPerSlot;
        chordEvents.push({ tick: startTick, type: "note", note: midi, velocity: Math.min(127, vel), duration: durTicks });
      });
    });
    sectionOffset += TIMELINE_SLOTS;
  });

  const chordTrack = { name: "Chords", channel: 0, events: chordEvents };

  // Bass track
  const bassEvents = [];
  sectionOffset = 0;
  resolvedSections.forEach(sec => {
    const bl = sec.bassLine || [];
    bl.forEach(note => {
      if (note.muted) return;
      const startTick = (sectionOffset + note.startSlot) * ticksPerSlot;
      const durTicks = note.lengthSlots * ticksPerSlot;
      bassEvents.push({ tick: startTick, type: "note", note: note.midi, velocity: note.velocity || 90, duration: durTicks });
    });
    sectionOffset += TIMELINE_SLOTS;
  });

  const bassTrack = { name: "Bass", channel: 1, events: bassEvents };

  // Melody track
  const melodyEvents = [];
  sectionOffset = 0;
  resolvedSections.forEach(sec => {
    const ml = sec.melodyLine || [];
    ml.forEach(note => {
      if (note.muted) return;
      const startTick = (sectionOffset + note.startSlot) * ticksPerSlot;
      const durTicks = note.lengthSlots * ticksPerSlot;
      melodyEvents.push({ tick: startTick, type: "note", note: note.midi, velocity: note.velocity || 85, duration: durTicks });
    });
    sectionOffset += TIMELINE_SLOTS;
  });

  const melodyTrack = { name: "Melody", channel: 2, events: melodyEvents };

  // Drum track (channel 9 = MIDI ch 10)
  const drumEvents = [];
  sectionOffset = 0;
  resolvedSections.forEach(sec => {
    const dp = sec.drumPattern;
    if (!dp) return;
    DRUM_TRACKS.forEach(track => {
      const steps = dp[track.id];
      if (!steps) return;
      const midiNote = padMap?.[track.id]?.midiNote ?? track.defaultNote;
      steps.forEach((vel, step) => {
        if (vel === 0) return;
        const startTick = (sectionOffset + step) * ticksPerSlot;
        const durTicks = ticksPerSlot;
        drumEvents.push({ tick: startTick, type: "note", note: midiNote, velocity: vel, duration: durTicks });
      });
    });
    sectionOffset += TIMELINE_SLOTS;
  });

  const drumTrack = { name: "Drums", channel: 9, events: drumEvents };

  const tracks = [tempoTrack, chordTrack];
  if (bassEvents.length > 0) tracks.push(bassTrack);
  if (melodyEvents.length > 0) tracks.push(melodyTrack);
  if (drumEvents.length > 0) tracks.push(drumTrack);

  return buildMidiFile(tracks, PPQ);
}

// Export MPC drum program (.xpm) — XML-based format
function exportMpcDrumProgram(padMap, DRUM_TRACKS) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<MPCVObject type="DrumProgram" version="1.0">\n';
  xml += '  <Layers count="16">\n';
  DRUM_TRACKS.forEach((track, i) => {
    const mapping = padMap[track.id];
    const note = mapping?.midiNote ?? track.defaultNote;
    const pad = mapping?.padId ?? track.defaultPad;
    xml += `    <Layer index="${i}" pad="${pad}" midiNote="${note}">\n`;
    xml += `      <Name>${track.label}</Name>\n`;
    xml += `      <Volume>1.0</Volume>\n`;
    xml += `      <Pan>0.0</Pan>\n`;
    xml += '    </Layer>\n';
  });
  xml += '  </Layers>\n';
  xml += '</MPCVObject>\n';
  return xml;
}

// ─── Chord rhythm patterns ──────────────────────────────────────────────────
// Each pattern returns an array of { offset, duration, velMult } per slot
// offset/duration are in fractions of the chord's total length (0..1)

const CHORD_PLAY_PATTERNS = {
  sustained: {
    label: "Sustained", desc: "Full sustained chords — default",
    melodyVelMult: 1.0,
    generate: () => [{ offset: 0, duration: 1, velMult: 1 }],
  },
  staccato: {
    label: "Staccato", desc: "Short choppy hits on each beat — lo-fi / hip-hop",
    melodyVelMult: 0.75,
    generate: (lenSlots) => {
      const hits = [];
      const beatLen = 4; // quarter note = 4 sixteenths
      const beats = Math.floor(lenSlots / beatLen);
      for (let b = 0; b < Math.max(1, beats); b++) {
        hits.push({ offset: (b * beatLen) / lenSlots, duration: 2 / lenSlots, velMult: b === 0 ? 1 : 0.7 });
      }
      return hits;
    },
  },
  trap: {
    label: "Trap", desc: "Hit on 1, ghost on and-of-2, hit on 3 — trap / modern rap",
    melodyVelMult: 0.85,
    generate: (lenSlots) => {
      const hits = [];
      // Beat 1 — hard hit
      hits.push({ offset: 0, duration: 3 / lenSlots, velMult: 1 });
      // And-of-2 — ghost
      if (lenSlots >= 8) hits.push({ offset: 6 / lenSlots, duration: 2 / lenSlots, velMult: 0.35 });
      // Beat 3 — hard hit
      if (lenSlots >= 12) hits.push({ offset: 8 / lenSlots, duration: 3 / lenSlots, velMult: 0.85 });
      // Ghost before 4
      if (lenSlots >= 16) hits.push({ offset: 14 / lenSlots, duration: 2 / lenSlots, velMult: 0.3 });
      return hits;
    },
  },
  griselda: {
    label: "Griselda", desc: "Gritty boom-bap stabs — Griselda / 90s NY",
    melodyVelMult: 0.9,
    generate: (lenSlots) => {
      const hits = [];
      // Hard stab on 1
      hits.push({ offset: 0, duration: 2 / lenSlots, velMult: 1 });
      // Stab on and-of-1
      if (lenSlots >= 4) hits.push({ offset: 3 / lenSlots, duration: 1 / lenSlots, velMult: 0.5 });
      // Hard stab on 3
      if (lenSlots >= 12) hits.push({ offset: 8 / lenSlots, duration: 2 / lenSlots, velMult: 0.95 });
      // Pickup stab on and-of-4
      if (lenSlots >= 16) hits.push({ offset: 15 / lenSlots, duration: 1 / lenSlots, velMult: 0.6 });
      return hits;
    },
  },
  lofi: {
    label: "Lo-Fi", desc: "Lazy offbeat hits with gaps — lo-fi hip-hop / chill",
    melodyVelMult: 0.6,
    generate: (lenSlots) => {
      const hits = [];
      // Slightly late beat 1
      hits.push({ offset: 1 / lenSlots, duration: 3 / lenSlots, velMult: 0.75 });
      // Beat 2 rest, hit on and-of-2
      if (lenSlots >= 8) hits.push({ offset: 7 / lenSlots, duration: 2 / lenSlots, velMult: 0.5 });
      // Beat 3 — slightly softer
      if (lenSlots >= 12) hits.push({ offset: 9 / lenSlots, duration: 3 / lenSlots, velMult: 0.65 });
      return hits;
    },
  },
  rnbPulse: {
    label: "R&B Pulse", desc: "Smooth eighth-note pumps — R&B / neo-soul",
    melodyVelMult: 0.7,
    generate: (lenSlots) => {
      const hits = [];
      const eighthLen = 2;
      const count = Math.floor(lenSlots / eighthLen);
      for (let i = 0; i < count; i++) {
        hits.push({
          offset: (i * eighthLen) / lenSlots,
          duration: (eighthLen * 0.6) / lenSlots,
          velMult: i % 2 === 0 ? 0.85 : 0.5,
        });
      }
      return hits;
    },
  },
  soulStab: {
    label: "Soul Stab", desc: "Rhythmic stabs with anticipation — classic soul / funk",
    melodyVelMult: 0.8,
    generate: (lenSlots) => {
      const hits = [];
      // Anticipation (16th before beat 1 of next bar mapped to end of current)
      // Beat 1 hard
      hits.push({ offset: 0, duration: 2 / lenSlots, velMult: 1 });
      // And-of-2
      if (lenSlots >= 8) hits.push({ offset: 5 / lenSlots, duration: 2 / lenSlots, velMult: 0.7 });
      // Beat 4
      if (lenSlots >= 16) hits.push({ offset: 12 / lenSlots, duration: 2 / lenSlots, velMult: 0.8 });
      // Anticipation hit (last 16th)
      if (lenSlots >= 16) hits.push({ offset: (lenSlots - 1) / lenSlots, duration: 1 / lenSlots, velMult: 0.9 });
      return hits;
    },
  },
  nordicArp: {
    label: "Nordic Arp", desc: "Broken chord arpeggiation — Nordic pop / ambient",
    melodyVelMult: 0.65,
    generate: (lenSlots) => {
      // This is handled specially in scheduling — breaks chord into individual notes
      const hits = [];
      const eighthLen = 2;
      const count = Math.floor(lenSlots / eighthLen);
      for (let i = 0; i < count; i++) {
        hits.push({
          offset: (i * eighthLen) / lenSlots,
          duration: (eighthLen * 1.5) / lenSlots, // overlapping sustain
          velMult: 0.6 + (i % 3 === 0 ? 0.3 : 0),
          _arpNote: i, // flag: use individual chord note instead of full chord
        });
      }
      return hits;
    },
  },
};

// ─── Bass line generation ────────────────────────────────────────────────────

const BASS_PATTERNS = {
  root: { label: "Root Notes", desc: "Root note on beat 1 of each chord" },
  rootFifth: { label: "Root + Fifth", desc: "Alternating root and fifth" },
  walking: { label: "Walking Bass", desc: "Stepwise motion connecting chord tones" },
  octave: { label: "Octave Bounce", desc: "Root note bouncing between octaves" },
  syncopated: { label: "Syncopated", desc: "Off-beat rhythmic pattern" },
  sub808: { label: "808 Sub", desc: "Long sustained sub notes — hip-hop / trap" },
  soulGroove: { label: "Soul Groove", desc: "Funky root-fifth-octave with ghost notes — soul / R&B" },
  nordicPulse: { label: "Nordic Pulse", desc: "Steady eighth-note pulse — Nordic pop drive" },
  darkDrone: { label: "Dark Drone", desc: "Low sustained root with minor-second dissonance — dark ambient" },
  minorCrawl: { label: "Minor Crawl", desc: "Slow chromatic descent from root — horror / tension" },
  doomSub: { label: "Doom Sub", desc: "Heavy sub with tritone stabs — grimy / sinister" },
  glitch808: { label: "Glitch 808", desc: "Stuttering sub hits with rests — dark trap / experimental" },
};

function generateBassLine(timelineItems, scaleKey, rootIdx, chordOctave, patternType = "root", TIMELINE_SLOTS, bassOctaveOffset = 0) {
  const bassOctave = Math.max(1, chordOctave - 1 + bassOctaveOffset);
  const notes = [];
  const scaleIntervals = SCALES[scaleKey]?.intervals || SCALES.major.intervals;
  const scaleNotes = scaleIntervals.map(iv => (rootIdx + iv) % 12);

  // Find nearest scale tone below a given note index
  const nearestScaleBelow = (ni) => {
    for (let d = 0; d <= 6; d++) {
      const check = ((ni - d) % 12 + 12) % 12;
      if (scaleNotes.includes(check)) return check;
    }
    return ni;
  };

  timelineItems.forEach(item => {
    const root = item.chord.noteIdx;
    const rootMidi = root + (bassOctave + 1) * 12;
    const fifth = (root + 7) % 12;
    const fifthMidi = fifth + (bassOctave + (fifth < root ? 2 : 1)) * 12;
    const third = CHORD_INTERVALS[item.chord.quality]?.[1] || 4;
    const thirdNote = (root + third) % 12;
    const thirdMidi = thirdNote + (bassOctave + (thirdNote < root ? 2 : 1)) * 12;
    const start = item.startSlot;
    const len = item.lengthSlots;

    if (patternType === "root") {
      notes.push({ midi: rootMidi, startSlot: start, lengthSlots: len, velocity: 95 });
    } else if (patternType === "rootFifth") {
      const half = Math.floor(len / 2);
      notes.push({ midi: rootMidi, startSlot: start, lengthSlots: half || len, velocity: 95 });
      if (half > 0) notes.push({ midi: fifthMidi, startSlot: start + half, lengthSlots: len - half, velocity: 80 });
    } else if (patternType === "walking") {
      // Quarter note walking: root, passing tone, third, fifth (or approach note)
      const beatLen = 4; // 16th notes per quarter
      const beats = Math.floor(len / beatLen);
      const walkNotes = [rootMidi, thirdMidi, fifthMidi];
      // Add chromatic approach to next chord's root
      for (let b = 0; b < beats; b++) {
        let midi;
        if (b === 0) midi = rootMidi;
        else if (b === beats - 1) {
          // Approach note: half step below next root
          const nextItem = timelineItems.find(it => it.startSlot === start + len);
          if (nextItem) {
            midi = nextItem.chord.noteIdx + (bassOctave + 1) * 12 - 1;
          } else {
            midi = fifthMidi;
          }
        } else {
          midi = walkNotes[b % walkNotes.length];
        }
        notes.push({ midi, startSlot: start + b * beatLen, lengthSlots: beatLen, velocity: b === 0 ? 95 : 75 });
      }
    } else if (patternType === "octave") {
      const half = Math.floor(len / 2);
      notes.push({ midi: rootMidi, startSlot: start, lengthSlots: half || len, velocity: 95 });
      if (half > 0) notes.push({ midi: rootMidi + 12, startSlot: start + half, lengthSlots: len - half, velocity: 80 });
    } else if (patternType === "syncopated") {
      // Syncopated: hit on 1, skip 2, hit on "and" of 2, hit on 4
      const beatLen = 4;
      const beats = Math.floor(len / beatLen);
      if (beats >= 1) notes.push({ midi: rootMidi, startSlot: start, lengthSlots: beatLen, velocity: 100 });
      if (beats >= 2) notes.push({ midi: fifthMidi, startSlot: start + beatLen + 2, lengthSlots: 2, velocity: 75 });
      if (beats >= 3) notes.push({ midi: thirdMidi, startSlot: start + beatLen * 2 + 2, lengthSlots: 2, velocity: 70 });
      if (beats >= 4) notes.push({ midi: rootMidi, startSlot: start + beatLen * 3, lengthSlots: beatLen, velocity: 90 });

    } else if (patternType === "sub808") {
      // 808 Sub: long sustained root with occasional slides — hip-hop / trap
      // Whole chord = one long sub note, with a short re-trigger on beat 3
      notes.push({ midi: rootMidi, startSlot: start, lengthSlots: Math.min(len, 8), velocity: 110 });
      if (len > 8) {
        // Re-trigger or slide to fifth on beat 3
        const slideTo = Math.random() < 0.4 ? fifthMidi : rootMidi;
        notes.push({ midi: slideTo, startSlot: start + 8, lengthSlots: len - 8, velocity: 95 });
      }

    } else if (patternType === "soulGroove") {
      // Soul groove: funky pattern — root, ghost, fifth, ghost, root octave up, ghost
      const beatLen = 4;
      const beats = Math.floor(len / beatLen);
      const pattern = [
        { midi: rootMidi, dur: 3, vel: 100 },
        { midi: rootMidi, dur: 1, vel: 40 },  // ghost
        { midi: fifthMidi, dur: 3, vel: 85 },
        { midi: thirdMidi, dur: 1, vel: 40 },  // ghost
      ];
      let pos = 0;
      let pIdx = 0;
      while (pos < len) {
        const p = pattern[pIdx % pattern.length];
        const dur = Math.min(p.dur, len - pos);
        if (dur > 0) notes.push({ midi: p.midi, startSlot: start + pos, lengthSlots: dur, velocity: p.vel });
        pos += dur;
        pIdx++;
      }

    } else if (patternType === "nordicPulse") {
      // Nordic pulse: steady eighth notes on root, with octave on beats 2 and 4
      const eighthLen = 2; // 2 sixteenths = one eighth
      let pos = 0;
      let beat = 0;
      while (pos < len) {
        const isUpbeat = (beat % 4 === 1 || beat % 4 === 3);
        const midi = isUpbeat ? rootMidi + 12 : rootMidi;
        const vel = isUpbeat ? 70 : 90;
        const dur = Math.min(eighthLen, len - pos);
        if (dur > 0) notes.push({ midi, startSlot: start + pos, lengthSlots: dur, velocity: vel });
        pos += eighthLen;
        beat++;
      }

    } else if (patternType === "darkDrone") {
      // Dark drone: sustained root with a dissonant minor 2nd layered
      const b2Midi = rootMidi + 1; // minor second above root
      notes.push({ midi: rootMidi, startSlot: start, lengthSlots: len, velocity: 100 });
      // Minor 2nd ghost creeps in on beat 3
      if (len >= 12) {
        notes.push({ midi: b2Midi, startSlot: start + 8, lengthSlots: Math.min(4, len - 8), velocity: 45 });
      }

    } else if (patternType === "minorCrawl") {
      // Chromatic descent from root — one step per beat, creepy
      const beatLen = 4;
      const beats = Math.floor(len / beatLen);
      for (let b = 0; b < Math.max(1, beats); b++) {
        const midi = rootMidi - b; // chromatic down
        const vel = b === 0 ? 100 : 80 - b * 5;
        notes.push({ midi: Math.max(24, midi), startSlot: start + b * beatLen, lengthSlots: beatLen, velocity: Math.max(50, vel) });
      }

    } else if (patternType === "doomSub") {
      // Doom sub: heavy root hit, then tritone stab, silence, root again
      const tritone = rootMidi + 6; // tritone = 6 semitones
      notes.push({ midi: rootMidi, startSlot: start, lengthSlots: Math.min(6, len), velocity: 115 });
      if (len >= 10) {
        notes.push({ midi: tritone, startSlot: start + 6, lengthSlots: 2, velocity: 85 });
      }
      // Second half: root with diminished feel
      if (len >= 14) {
        notes.push({ midi: rootMidi, startSlot: start + 12, lengthSlots: Math.min(4, len - 12), velocity: 100 });
      }

    } else if (patternType === "glitch808") {
      // Stuttering sub: short bursts with gaps — dark trap
      const pattern = [
        { off: 0, dur: 2, vel: 110 },
        { off: 3, dur: 1, vel: 70 },
        { off: 6, dur: 2, vel: 100 },
        { off: 10, dur: 1, vel: 55 },
        { off: 12, dur: 3, vel: 95 },
      ];
      pattern.forEach(p => {
        if (p.off < len) {
          notes.push({ midi: rootMidi, startSlot: start + p.off, lengthSlots: Math.min(p.dur, len - p.off), velocity: p.vel });
        }
      });
    }
  });

  return notes;
}

// ─── Topline / melody generation ─────────────────────────────────────────────

const MELODY_PATTERNS = {
  chordTones:  { label: "Chord Tones",   desc: "Melody from chord notes — safe and musical" },
  stepwise:    { label: "Stepwise",      desc: "Scale steps with occasional leaps — singable" },
  pentatonic:  { label: "Pentatonic",    desc: "Pentatonic scale only — catchy and universal" },
  callResponse:{ label: "Call & Response",desc: "2-bar phrases with answers" },
  rhythmic:    { label: "Rhythmic",      desc: "Repetitive rhythm, changing pitch" },
  trapFlow:    { label: "Trap Flow",     desc: "Rapid hi-hat triplet feel — hip-hop vocal cadence" },
  soulMelisma: { label: "Soul Melisma",  desc: "Ornamented runs with grace notes — R&B / soul" },
  nordicWide:  { label: "Nordic Wide",   desc: "Wide intervals, open spaces — Scandi pop feel" },
  minorDescent:{ label: "Minor Descent", desc: "Descending minor scale — melancholy, dark" },
  darkArp:     { label: "Dark Arp",      desc: "Minor arpeggio with chromatic passing tones — sinister" },
  chromCreep:  { label: "Chromatic Creep",desc: "Slow chromatic movement — tension, unease" },
  haunted:     { label: "Haunted",       desc: "Sparse, wide intervals with long silences — eerie" },
};

function generateMelody(timelineItems, scaleKey, rootIdx, chordOctave, patternType, TIMELINE_SLOTS, melodyOctaveOffset = 0) {
  const melOctave = chordOctave + 1 + melodyOctaveOffset;
  const notes = [];
  const scaleIntervals = SCALES[scaleKey]?.intervals || SCALES.major.intervals;
  const scaleNotes = scaleIntervals.map(iv => (rootIdx + iv) % 12);
  // Build pentatonic from scale (degrees 1,2,3,5,6 → indices 0,1,2,4,5)
  const pentDegrees = scaleIntervals.length >= 7 ? [0,1,2,4,5] : [0,1,2,3,4];
  const pentNotes = pentDegrees.map(d => scaleNotes[d]);

  // Helper: get chord tones as MIDI numbers in melody octave
  const chordMidis = (item) => {
    const intervals = CHORD_INTERVALS[item.chord.quality] || CHORD_INTERVALS["maj"];
    return intervals.map(iv => {
      const ni = (item.chord.noteIdx + iv) % 12;
      let oct = melOctave;
      if (ni + oct * 12 + 12 < 60) oct++; // keep in singable range
      return ni + oct * 12 + 12;
    });
  };

  // Helper: nearest scale note midi above/below a target
  const scaleToMidi = (degreeIdx, oct) => {
    const ni = scaleNotes[((degreeIdx % scaleNotes.length) + scaleNotes.length) % scaleNotes.length];
    return ni + oct * 12 + 12;
  };

  // Helper: random pick
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // Keep melody in a nice range
  const clampMidi = (m) => Math.max(60, Math.min(84, m));

  let lastMidi = null;

  if (patternType === "chordTones") {
    // Arpeggiate through chord tones with rhythm variety
    timelineItems.forEach(item => {
      const midis = chordMidis(item);
      const start = item.startSlot;
      const len = item.lengthSlots;
      const beatLen = 4; // sixteenth notes per beat
      const beats = Math.floor(len / beatLen);

      // Rhythm: mix of quarter and eighth notes
      let pos = 0;
      let noteIdx = 0;
      while (pos < len) {
        const midi = clampMidi(midis[noteIdx % midis.length]);
        // Vary note lengths: 70% quarter, 20% eighth, 10% half
        const r = Math.random();
        const noteDur = r < 0.1 && pos + 8 <= len ? 8 : r < 0.3 && pos + 2 <= len ? 2 : Math.min(4, len - pos);
        if (noteDur > 0) {
          const vel = noteIdx === 0 ? 95 : 70 + Math.floor(Math.random() * 20);
          notes.push({ midi, startSlot: start + pos, lengthSlots: noteDur, velocity: vel });
          lastMidi = midi;
        }
        pos += noteDur;
        noteIdx++;
      }
    });

  } else if (patternType === "stepwise") {
    // Scale-step melody — mostly steps (±1 degree), occasional leap
    let degree = scaleNotes.indexOf(timelineItems[0]?.chord.noteIdx % 12);
    if (degree < 0) degree = 0;
    let oct = melOctave;

    timelineItems.forEach(item => {
      const start = item.startSlot;
      const len = item.lengthSlots;
      const chordRoot = item.chord.noteIdx % 12;

      // Start near chord root
      const rootDeg = scaleNotes.indexOf(chordRoot);
      if (rootDeg >= 0 && Math.abs(rootDeg - degree) > 3) degree = rootDeg;

      let pos = 0;
      while (pos < len) {
        const midi = clampMidi(scaleToMidi(degree, oct));
        // Note durations: mostly 2-4 sixteenths
        const noteDur = pick([2, 2, 4, 4, 4, 3]);
        const actualDur = Math.min(noteDur, len - pos);
        if (actualDur > 0) {
          notes.push({ midi, startSlot: start + pos, lengthSlots: actualDur, velocity: 75 + Math.floor(Math.random() * 20) });
          lastMidi = midi;
        }
        pos += actualDur;
        // Move: 60% step, 25% same, 15% leap
        const motion = Math.random();
        if (motion < 0.6) degree += pick([-1, 1]);
        else if (motion < 0.85) { /* stay */ }
        else degree += pick([-2, 2, -3, 3]);
        // Clamp octave
        if (degree > scaleNotes.length + 2) { degree -= scaleNotes.length; oct++; }
        if (degree < -2) { degree += scaleNotes.length; oct--; }
        oct = Math.max(melOctave - 1, Math.min(melOctave + 1, oct));
      }
    });

  } else if (patternType === "pentatonic") {
    // Pentatonic — only 5 notes, very catchy
    let pentIdx = 0;
    timelineItems.forEach(item => {
      const start = item.startSlot;
      const len = item.lengthSlots;
      let pos = 0;
      while (pos < len) {
        const ni = pentNotes[((pentIdx % pentNotes.length) + pentNotes.length) % pentNotes.length];
        let oct = melOctave;
        const midi = clampMidi(ni + oct * 12 + 12);
        const noteDur = pick([2, 3, 4, 4, 6]);
        const actualDur = Math.min(noteDur, len - pos);
        if (actualDur > 0) {
          // Add occasional rests (20% chance)
          if (Math.random() > 0.2) {
            notes.push({ midi, startSlot: start + pos, lengthSlots: actualDur, velocity: 80 + Math.floor(Math.random() * 15) });
          }
          lastMidi = midi;
        }
        pos += actualDur;
        pentIdx += pick([-1, 1, 1, 2]);
      }
    });

  } else if (patternType === "callResponse") {
    // 2-bar call, 2-bar response structure
    const halfLen = Math.floor(TIMELINE_SLOTS / 2);
    const callItems = timelineItems.filter(it => it.startSlot < halfLen);
    const respItems = timelineItems.filter(it => it.startSlot >= halfLen);

    const generatePhrase = (items, isResponse) => {
      // Generate a short motif (3-5 notes) and repeat/vary it
      const motif = [];
      const numNotes = 3 + Math.floor(Math.random() * 3);
      let degree = scaleNotes.indexOf(items[0]?.chord.noteIdx % 12);
      if (degree < 0) degree = 0;

      for (let i = 0; i < numNotes; i++) {
        const dur = pick([2, 3, 4]);
        motif.push({ degreeDelta: degree, dur, vel: i === 0 ? 95 : 70 + Math.floor(Math.random() * 20) });
        degree += pick([-1, 1, 1, 2, -2]);
      }

      items.forEach(item => {
        const start = item.startSlot;
        const len = item.lengthSlots;
        let pos = 0;
        let motifIdx = 0;
        // Response: transpose motif up or down
        const transpose = isResponse ? pick([2, 3, -2, 5]) : 0;

        while (pos < len && motifIdx < motif.length * 2) {
          const m = motif[motifIdx % motif.length];
          const deg = m.degreeDelta + transpose;
          const midi = clampMidi(scaleToMidi(deg, melOctave));
          const actualDur = Math.min(m.dur, len - pos);
          if (actualDur > 0) {
            notes.push({ midi, startSlot: start + pos, lengthSlots: actualDur, velocity: m.vel });
          }
          pos += actualDur;
          motifIdx++;
          // Add small rest between notes occasionally
          if (Math.random() < 0.3) pos += 1;
        }
      });
    };

    generatePhrase(callItems, false);
    generatePhrase(respItems, true);

  } else if (patternType === "rhythmic") {
    // Same rhythm pattern, pitch follows chord root
    // Create a 1-bar rhythm template
    const template = [];
    let pos = 0;
    while (pos < 16) {
      const dur = pick([2, 2, 3, 4]);
      const isRest = Math.random() < 0.15;
      template.push({ pos, dur, isRest });
      pos += dur;
    }

    timelineItems.forEach(item => {
      const start = item.startSlot;
      const len = item.lengthSlots;
      const midis = chordMidis(item);
      const bars = Math.floor(len / 16);

      for (let bar = 0; bar < Math.max(1, bars); bar++) {
        template.forEach((t, idx) => {
          const absPos = bar * 16 + t.pos;
          if (absPos >= len || t.isRest) return;
          const midi = clampMidi(midis[idx % midis.length]);
          const actualDur = Math.min(t.dur, len - absPos);
          if (actualDur > 0) {
            notes.push({ midi, startSlot: start + absPos, lengthSlots: actualDur, velocity: idx === 0 ? 95 : 78 });
          }
        });
      }
    });

  } else if (patternType === "trapFlow") {
    // Trap vocal cadence: rapid triplet-feel notes on pentatonic, with pauses
    let pentIdx = Math.floor(Math.random() * pentNotes.length);
    timelineItems.forEach(item => {
      const start = item.startSlot;
      const len = item.lengthSlots;
      let pos = 0;
      while (pos < len) {
        // Triplet burst (3 quick notes) then a gap
        if (Math.random() < 0.7 && pos + 6 <= len) {
          // 3 notes each ~2 sixteenths
          for (let t = 0; t < 3; t++) {
            const ni = pentNotes[((pentIdx) % pentNotes.length + pentNotes.length) % pentNotes.length];
            const midi = clampMidi(ni + melOctave * 12 + 12);
            notes.push({ midi, startSlot: start + pos, lengthSlots: 2, velocity: t === 0 ? 95 : 75 });
            pos += 2;
            pentIdx += pick([-1, 1, 0]);
          }
          // Rest after burst
          pos += pick([2, 4]);
        } else {
          // Single held note
          const ni = pentNotes[((pentIdx) % pentNotes.length + pentNotes.length) % pentNotes.length];
          const midi = clampMidi(ni + melOctave * 12 + 12);
          const dur = pick([4, 6, 8]);
          const actualDur = Math.min(dur, len - pos);
          if (actualDur > 0) {
            notes.push({ midi, startSlot: start + pos, lengthSlots: actualDur, velocity: 90 });
          }
          pos += actualDur;
          pentIdx += pick([-1, 1, 2]);
        }
      }
    });

  } else if (patternType === "soulMelisma") {
    // Soul melisma: longer held notes with fast ornamental runs between them
    let degree = scaleNotes.indexOf(timelineItems[0]?.chord.noteIdx % 12);
    if (degree < 0) degree = 0;

    timelineItems.forEach(item => {
      const start = item.startSlot;
      const len = item.lengthSlots;
      const chordRoot = item.chord.noteIdx % 12;
      const rootDeg = scaleNotes.indexOf(chordRoot);
      if (rootDeg >= 0) degree = rootDeg;

      let pos = 0;
      while (pos < len) {
        // Main note — held
        const mainMidi = clampMidi(scaleToMidi(degree, melOctave));
        const holdDur = pick([4, 6, 8]);
        const actualHold = Math.min(holdDur, len - pos);
        if (actualHold > 0) {
          notes.push({ midi: mainMidi, startSlot: start + pos, lengthSlots: actualHold, velocity: 90 });
        }
        pos += actualHold;

        // Melisma run (30% chance): fast 1-sixteenth notes up or down the scale
        if (Math.random() < 0.3 && pos + 4 <= len) {
          const dir = pick([-1, 1]);
          for (let r = 0; r < pick([2, 3, 4]); r++) {
            if (pos >= len) break;
            degree += dir;
            const runMidi = clampMidi(scaleToMidi(degree, melOctave));
            notes.push({ midi: runMidi, startSlot: start + pos, lengthSlots: 1, velocity: 70 });
            pos += 1;
          }
        }
        degree += pick([-1, 1, 2, -2]);
      }
    });

  } else if (patternType === "nordicWide") {
    // Nordic wide: large intervals (4ths, 5ths, octaves), spacious with rests
    let degree = 0;
    const rootDeg0 = scaleNotes.indexOf(timelineItems[0]?.chord.noteIdx % 12);
    if (rootDeg0 >= 0) degree = rootDeg0;

    timelineItems.forEach(item => {
      const start = item.startSlot;
      const len = item.lengthSlots;
      const chordRoot = item.chord.noteIdx % 12;
      const rootDeg = scaleNotes.indexOf(chordRoot);
      if (rootDeg >= 0 && Math.abs(rootDeg - degree) > 4) degree = rootDeg;

      let pos = 0;
      while (pos < len) {
        const midi = clampMidi(scaleToMidi(degree, melOctave));
        // Longer notes with breathing room
        const dur = pick([4, 6, 8, 8, 12]);
        const actualDur = Math.min(dur, len - pos);
        if (actualDur > 0) {
          // 25% chance of rest instead of note (Nordic spaciousness)
          if (Math.random() > 0.25) {
            notes.push({ midi, startSlot: start + pos, lengthSlots: actualDur, velocity: 80 + Math.floor(Math.random() * 15) });
          }
        }
        pos += actualDur;
        // Wide leaps: 4ths, 5ths, octaves
        degree += pick([-3, 3, -4, 4, -5, 5, 7, -7]);
        if (degree > scaleNotes.length + 3) degree -= scaleNotes.length;
        if (degree < -3) degree += scaleNotes.length;
      }
    });

  } else if (patternType === "minorDescent") {
    // Descending through scale degrees — melancholic, downward pull
    timelineItems.forEach(item => {
      const start = item.startSlot;
      const len = item.lengthSlots;
      const chordRoot = item.chord.noteIdx % 12;
      let degree = scaleNotes.indexOf(chordRoot);
      if (degree < 0) degree = 0;
      degree += 4; // start high

      let pos = 0;
      while (pos < len) {
        const midi = clampMidi(scaleToMidi(degree, melOctave));
        const dur = pick([3, 4, 4, 6]);
        const actualDur = Math.min(dur, len - pos);
        if (actualDur > 0) {
          notes.push({ midi, startSlot: start + pos, lengthSlots: actualDur, velocity: 70 + Math.floor(Math.random() * 15) });
        }
        pos += actualDur;
        // Always descend, occasionally skip a step
        degree += Math.random() < 0.3 ? -2 : -1;
      }
    });

  } else if (patternType === "darkArp") {
    // Dark arpeggio: minor chord tones with chromatic passing tones between them
    timelineItems.forEach(item => {
      const midis = chordMidis(item);
      const start = item.startSlot;
      const len = item.lengthSlots;
      let pos = 0;
      let idx = 0;
      let goingUp = true;

      while (pos < len) {
        const chordMidi = midis[idx % midis.length];
        // Play chord tone
        const dur = 2;
        const actualDur = Math.min(dur, len - pos);
        if (actualDur > 0) {
          notes.push({ midi: clampMidi(chordMidi), startSlot: start + pos, lengthSlots: actualDur, velocity: 85 });
        }
        pos += actualDur;

        // Chromatic passing tone (half step below next chord tone) — 40% chance
        if (Math.random() < 0.4 && pos < len) {
          const nextChord = midis[(idx + 1) % midis.length];
          const passingTone = nextChord - 1;
          const pDur = Math.min(1, len - pos);
          if (pDur > 0) {
            notes.push({ midi: clampMidi(passingTone), startSlot: start + pos, lengthSlots: pDur, velocity: 55 });
          }
          pos += pDur;
        }

        if (goingUp) { idx++; if (idx >= midis.length) { goingUp = false; idx = midis.length - 2; } }
        else { idx--; if (idx < 0) { goingUp = true; idx = 1; } }
      }
    });

  } else if (patternType === "chromCreep") {
    // Slow chromatic movement — tension builder
    timelineItems.forEach(item => {
      const start = item.startSlot;
      const len = item.lengthSlots;
      const rootMidi = clampMidi(item.chord.noteIdx + melOctave * 12 + 12);
      let current = rootMidi;
      const dir = Math.random() < 0.5 ? 1 : -1;

      let pos = 0;
      while (pos < len) {
        const dur = pick([4, 6, 6, 8]);
        const actualDur = Math.min(dur, len - pos);
        if (actualDur > 0) {
          notes.push({ midi: clampMidi(current), startSlot: start + pos, lengthSlots: actualDur, velocity: 65 + Math.floor(Math.random() * 15) });
        }
        pos += actualDur;
        current += dir; // one semitone at a time
      }
    });

  } else if (patternType === "haunted") {
    // Sparse, wide intervals with long silences — eerie atmosphere
    timelineItems.forEach(item => {
      const start = item.startSlot;
      const len = item.lengthSlots;
      const midis = chordMidis(item);
      let pos = 0;

      while (pos < len) {
        // 40% chance of silence
        if (Math.random() < 0.4) {
          pos += pick([4, 6, 8]);
          continue;
        }
        // Pick a chord tone and displace it by a wide interval
        const base = midis[Math.floor(Math.random() * midis.length)];
        const displacement = pick([-12, -7, -5, 5, 7, 12]); // octave, fifth, fourth
        const midi = clampMidi(base + displacement);
        const dur = pick([6, 8, 10, 12]);
        const actualDur = Math.min(dur, len - pos);
        if (actualDur > 0) {
          notes.push({ midi, startSlot: start + pos, lengthSlots: actualDur, velocity: 50 + Math.floor(Math.random() * 25) });
        }
        pos += actualDur + pick([2, 4]); // gap after note
      }
    });
  }

  return notes;
}

// ─── Sampler ─────────────────────────────────────────────────────────────────

let sampler = null;
function getSampler() {
  if (!sampler) {
    // Soft piano chain: Sampler → LPF (warmth) → Reverb (space) → Destination
    const pianoReverb = new Tone.Reverb({ decay: 3.2, wet: 0.25 }).toDestination();
    const pianoFilter = new Tone.Filter({ frequency: 4200, type: "lowpass", rolloff: -12 }).connect(pianoReverb);
    sampler = new Tone.Sampler({
      urls: {
        A1:"A1.mp3", A2:"A2.mp3", A3:"A3.mp3", A4:"A4.mp3", A5:"A5.mp3", A6:"A6.mp3", A7:"A7.mp3",
        C1:"C1.mp3", C2:"C2.mp3", C3:"C3.mp3", C4:"C4.mp3", C5:"C5.mp3", C6:"C6.mp3", C7:"C7.mp3",
        "D#1":"Ds1.mp3","D#2":"Ds2.mp3","D#3":"Ds3.mp3","D#4":"Ds4.mp3","D#5":"Ds5.mp3","D#6":"Ds6.mp3","D#7":"Ds7.mp3",
        "F#1":"Fs1.mp3","F#2":"Fs2.mp3","F#3":"Fs3.mp3","F#4":"Fs4.mp3","F#5":"Fs5.mp3","F#6":"Fs6.mp3","F#7":"Fs7.mp3",
      },
      release: 1.8,
      attack: 0.01,
      volume: -3,
      baseUrl: "https://tonejs.github.io/audio/salamander/",
    }).connect(pianoFilter);
  }
  return sampler;
}

// ─── Rhodes synth (FM) ───────────────────────────────────────────────────────

let rhodesSynth = null;
function getRhodesSynth() {
  if (!rhodesSynth) {
    const reverb = new Tone.Reverb({ decay: 2.5, wet: 0.22 }).toDestination();
    const chorus = new Tone.Chorus({ frequency: 3, delayTime: 3.5, depth: 0.45, wet: 0.3 }).connect(reverb);
    chorus.start();
    rhodesSynth = new Tone.PolySynth(Tone.FMSynth).connect(chorus);
    rhodesSynth.set({
      harmonicity: 2,
      modulationIndex: 5,
      oscillator: { type: "sine" },
      envelope: { attack: 0.005, decay: 1.0, sustain: 0.04, release: 1.8 },
      modulation: { type: "sine" },
      modulationEnvelope: { attack: 0.004, decay: 0.35, sustain: 0, release: 0.5 },
      volume: -10,
    });
  }
  return rhodesSynth;
}

function getInstrument(soundType) {
  return soundType === "rhodes" ? getRhodesSynth() : getSampler();
}

// ─── 808 Bass synth ─────────────────────────────────────────────────────────

let bass808Synth = null;
function getBass808() {
  if (!bass808Synth) {
    const dist = new Tone.Distortion({ distortion: 0.15, wet: 0.3 }).toDestination();
    const lpf = new Tone.Filter({ frequency: 600, type: "lowpass", rolloff: -24 }).connect(dist);
    bass808Synth = new Tone.MonoSynth({
      oscillator: { type: "sine" },
      envelope: { attack: 0.005, decay: 0.3, sustain: 0.6, release: 0.8 },
      filterEnvelope: { attack: 0.005, decay: 0.1, sustain: 0.3, release: 0.5, baseFrequency: 80, octaves: 2.5 },
      volume: -14,
    }).connect(lpf);
  }
  return bass808Synth;
}

// ─── Bell / Lead synth for melody ───────────────────────────────────────────

let bellLeadSynth = null;
function getBellLead() {
  if (!bellLeadSynth) {
    const reverb = new Tone.Reverb({ decay: 2.8, wet: 0.3 }).toDestination();
    const delay = new Tone.FeedbackDelay({ delayTime: "8n.", feedback: 0.15, wet: 0.2 }).connect(reverb);
    bellLeadSynth = new Tone.PolySynth(Tone.FMSynth).connect(delay);
    bellLeadSynth.set({
      harmonicity: 8,
      modulationIndex: 2,
      oscillator: { type: "sine" },
      envelope: { attack: 0.001, decay: 0.6, sustain: 0.05, release: 1.2 },
      modulation: { type: "sine" },
      modulationEnvelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.4 },
      volume: -10,
    });
  }
  return bellLeadSynth;
}

let pluckLeadSynth = null;
function getPluckLead() {
  if (!pluckLeadSynth) {
    const reverb = new Tone.Reverb({ decay: 2.0, wet: 0.25 }).toDestination();
    const chorus = new Tone.Chorus({ frequency: 2.5, delayTime: 4, depth: 0.4, wet: 0.25 }).connect(reverb);
    chorus.start();
    pluckLeadSynth = new Tone.PolySynth(Tone.Synth).connect(chorus);
    pluckLeadSynth.set({
      oscillator: { type: "triangle" },
      envelope: { attack: 0.005, decay: 0.3, sustain: 0.1, release: 0.8 },
      volume: -8,
    });
  }
  return pluckLeadSynth;
}

function getBassInstrument(bassSound) {
  if (bassSound === "808") return getBass808();
  return getInstrument("piano"); // default: same as chords
}

function getMelodyInstrument(melodySound) {
  if (melodySound === "bell") return getBellLead();
  if (melodySound === "pluck") return getPluckLead();
  return getInstrument("piano"); // default: same as chords
}

// ─── Drum synth engine (for preview without external MIDI) ───────────────────

let drumSynthsReady = false;
const drumSynths = {};

function initDrumSynths() {
  if (drumSynthsReady) return;
  drumSynthsReady = true;

  // Kick — deep membrane hit
  drumSynths.kick = new Tone.MembraneSynth({
    pitchDecay: 0.06, octaves: 6, envelope: { attack:0.001, decay:0.35, sustain:0, release:0.4 }, volume:-6
  }).toDestination();
  drumSynths.kick._type = "membrane";
  drumSynths.kick._note = "C1";

  // Snare — membrane + noise burst (layered)
  const snareNoise = new Tone.NoiseSynth({
    noise: { type:"white" }, envelope: { attack:0.001, decay:0.15, sustain:0, release:0.06 }, volume:-10
  }).toDestination();
  const snareMembrane = new Tone.MembraneSynth({
    pitchDecay:0.01, octaves:4, envelope:{attack:0.001,decay:0.12,sustain:0,release:0.1}, volume:-14
  }).toDestination();
  drumSynths.snare = { _type:"custom", fire(dur, time, vel) {
    snareNoise.triggerAttackRelease(dur, time, vel);
    snareMembrane.triggerAttackRelease("C3", dur, time, vel * 0.6);
  }};

  // Ghost snare — quieter snare hit
  drumSynths.ghost = { _type:"custom", fire(dur, time, vel) {
    snareNoise.triggerAttackRelease(dur * 0.6, time, vel * 0.35);
    snareMembrane.triggerAttackRelease("D3", dur * 0.5, time, vel * 0.2);
  }};

  // Closed hat — filtered noise, tight
  const hatFilter = new Tone.Filter(8000, "highpass").toDestination();
  drumSynths.hatC = new Tone.NoiseSynth({
    noise: { type:"white" }, envelope: { attack:0.001, decay:0.045, sustain:0, release:0.02 }, volume:-12
  }).connect(hatFilter);
  drumSynths.hatC._type = "noise";

  // Open hat — longer noise, shimmer
  const ohatFilter = new Tone.Filter(6500, "highpass").toDestination();
  drumSynths.hatO = new Tone.NoiseSynth({
    noise: { type:"white" }, envelope: { attack:0.001, decay:0.22, sustain:0.03, release:0.12 }, volume:-14
  }).connect(ohatFilter);
  drumSynths.hatO._type = "noise";

  // Clap — layered noise bursts with slight spread
  const clapFilter = new Tone.Filter(1200, "highpass").toDestination();
  drumSynths.clap = { _type:"custom", fire(dur, time, vel) {
    const c1 = new Tone.NoiseSynth({ noise:{type:"white"}, envelope:{attack:0.001,decay:0.01,sustain:0,release:0.01}, volume:-14 }).connect(clapFilter);
    const c2 = new Tone.NoiseSynth({ noise:{type:"pink"}, envelope:{attack:0.001,decay:0.12,sustain:0,release:0.06}, volume:-12 }).connect(clapFilter);
    c1.triggerAttackRelease(0.01, time, vel * 0.7);
    c2.triggerAttackRelease(dur, time + 0.012, vel);
    setTimeout(() => { c1.dispose(); c2.dispose(); }, 500);
  }};

  // Rim — sharp metallic click, high and tight
  const rimFilter = new Tone.Filter(2500, "highpass").toDestination();
  drumSynths.rim = new Tone.MetalSynth({
    frequency:800, envelope:{attack:0.001,decay:0.035,release:0.02},
    harmonicity:0.1, modulationIndex:2, resonance:6000, volume:-12
  }).connect(rimFilter);
  drumSynths.rim._type = "metal";

  // Tom — tuned membrane, punchy
  drumSynths.tom = new Tone.MembraneSynth({
    pitchDecay:0.05, octaves:3, envelope:{attack:0.001,decay:0.25,sustain:0,release:0.18}, volume:-8
  }).toDestination();
  drumSynths.tom._type = "membrane";
  drumSynths.tom._note = "G2";

  // 808 — deep sub bass
  drumSynths.low808 = new Tone.MembraneSynth({
    pitchDecay:0.08, octaves:8, envelope:{attack:0.001,decay:0.7,sustain:0.15,release:0.5}, volume:-4
  }).toDestination();
  drumSynths.low808._type = "membrane";
  drumSynths.low808._note = "C1";

  // Ride — metallic shimmer, longer sustain
  drumSynths.ride = new Tone.MetalSynth({
    frequency:320, envelope:{attack:0.001,decay:0.8,release:0.5},
    harmonicity:5.1, modulationIndex:18, resonance:4000, volume:-18
  }).toDestination();
  drumSynths.ride._type = "metal";

  // Shaker — crispy high noise, short
  const shakerFilter = new Tone.Filter(5500, "highpass").toDestination();
  const shakerBpf = new Tone.Filter({ frequency:9000, type:"bandpass", Q:1.5 }).connect(shakerFilter);
  drumSynths.shaker = new Tone.NoiseSynth({
    noise:{type:"white"}, envelope:{attack:0.002,decay:0.055,sustain:0,release:0.03}, volume:-10
  }).connect(shakerBpf);
  drumSynths.shaker._type = "noise";

  // Perc — short metallic tap
  drumSynths.perc = new Tone.MetalSynth({
    frequency:350, envelope:{attack:0.001,decay:0.15,release:0.08},
    harmonicity:5.1, modulationIndex:16, resonance:800, volume:-8
  }).toDestination();
  drumSynths.perc._type = "metal";

  // Ghost Kick — softer, shorter kick for ghost notes
  drumSynths.ghostKick = new Tone.MembraneSynth({
    pitchDecay:0.03, octaves:6, envelope:{attack:0.001,decay:0.12,sustain:0,release:0.06}, volume:-12
  }).toDestination();
  drumSynths.ghostKick._type = "membrane";
  drumSynths.ghostKick._note = "C2";

  // Crash — long metallic wash
  drumSynths.crash = new Tone.MetalSynth({
    frequency:350, envelope:{attack:0.001,decay:1.4,release:0.9},
    harmonicity:5.1, modulationIndex:32, resonance:4500, volume:-18
  }).toDestination();
  drumSynths.crash._type = "metal";
}

function triggerDrumSynth(trackId, velocity, duration) {
  const s = drumSynths[trackId];
  if (!s) return;
  const vel = Math.max(0.01, Math.min(1, velocity / 127));
  const dur = Math.max(0.02, duration || 0.1);
  const now = Tone.now();

  if (s._type === "custom" && s.fire) {
    s.fire(dur, now, vel);
  } else if (s._type === "membrane") {
    try { s.triggerAttackRelease(s._note || "C2", dur, now, vel); } catch(e) {}
  } else if (s._type === "metal") {
    try { s.triggerAttackRelease(dur, now, vel); } catch(e) {}
  } else if (s._type === "noise") {
    try { s.triggerAttackRelease(dur, now, vel); } catch(e) {}
  }
}

// ─── Theme ───────────────────────────────────────────────────────────────────

const THEME = {
  pageBg:"#EAEAE8", cardBg:"#FFFFFF", elevatedBg:"#E5E5E3",
  textPrimary:"#1A1A1A", textSecondary:"#555555", textTertiary:"#888888",
  labelColor:"#1A1A1A", border:"rgba(0,0,0,0.15)",
  inputBorder:"rgba(0,0,0,0.20)", inputBg:"#FFFFFF", inputColor:"#1A1A1A", colorScheme:"light",
  cardShadow:"none",
  accent:"#5C7C8A", accentBg:"rgba(92,124,138,0.10)", accentBgHover:"rgba(92,124,138,0.16)",
  accentBorder:"rgba(92,124,138,0.50)", accentCardBg:"rgba(92,124,138,0.05)", accentCardHover:"rgba(92,124,138,0.10)",
  degreeColor:"#888888", chordNameColor:"#1A1A1A", chordCardBg:"#FFFFFF",
  chordHoverShadow:"none",
  segBg:"#EAEAE8", segActiveBg:"#FFFFFF", segActiveColor:"#1A1A1A",
  segInactiveColor:"#888888", segShadow:"none",
  pianoRailBg:"#DDDDD9", pianoRailShadow:"none", pianoKeysBg:"#EAEAE8",
  whiteKeyBg:"#FFFFFF", whiteKeyScaleBg:"rgba(92,124,138,0.12)",
  whiteKeyHlBg:"#5C7C8A",
  whiteKeyAllScaleBg:"#5C7C8A",
  whiteKeyBorder:"rgba(0,0,0,0.13)", whiteKeyLabel:"rgba(0,0,0,0.50)", whiteKeyLabelHl:"#FFFFFF",
  blackKeyBg:"#2A2A2A", blackKeyScaleBg:"#5C7C8A",
  blackKeyHlBg:"#4A6878", blackKeyAllScaleBg:"#4A6878",
  legendChord:"#5C7C8A", legendScale:"rgba(92,124,138,0.12)", legendScaleBdr:"rgba(92,124,138,0.35)",
  slotBg:"#E5E5E3", slotBorder:"rgba(0,0,0,0.15)",
  tokenBg:"#FFFFFF", tokenBgHover:"rgba(92,124,138,0.10)", tokenBorder:"rgba(92,124,138,0.40)", tokenColor:"#5C7C8A",
  playActiveBg:"#5C7C8A", playDisabledBg:"rgba(0,0,0,0.12)", playDisabledClr:"rgba(0,0,0,0.45)",
  btnBg:"transparent", btnColor:"#1A1A1A", btnBorder:"rgba(0,0,0,0.15)",
  presetBg:"#FFFFFF", presetColor:"#1A1A1A",
  toggleBg:"#FFFFFF", toggleColor:"#1A1A1A", toggleBorder:"rgba(0,0,0,0.15)",
  stepBg:"#E5E5E3", stepColor:"#888888",
  stepWholeBg:"rgba(92,124,138,0.12)", stepWholeColor:"#5C7C8A", stepWholeBorder:"rgba(92,124,138,0.30)",
  stepHalfBg:"#FFFFFF", stepHalfColor:"#888888", stepHalfBorder:"rgba(0,0,0,0.15)",
  infoBg:"#E5E5E3", infoBorder:"rgba(0,0,0,0.08)",
  modeBtnActiveBg:"#FFFFFF", modeBtnActiveBorder:"rgba(0,0,0,0.15)", modeBtnActiveColor:"#1A1A1A",
  modeBtnBg:"transparent", modeBtnBorder:"transparent", modeBtnColor:"rgba(0,0,0,0.50)",
};

// ─── Data ────────────────────────────────────────────────────────────────────

const SCALES = {
  major:      { intervals:[0,2,4,5,7,9,11], qualities:["maj","min","min","maj","maj","min","dim"], degrees:["I","II","III","IV","V","VI","VII"] },
  minor:      { intervals:[0,2,3,5,7,8,10], qualities:["min","dim","maj","min","min","maj","maj"], degrees:["I","II","III","IV","V","VI","VII"] },
  dorian:     { intervals:[0,2,3,5,7,9,10], qualities:["min","min","maj","maj","min","dim","maj"], degrees:["I","II","III","IV","V","VI","VII"] },
  phrygian:   { intervals:[0,1,3,5,7,8,10], qualities:["min","maj","maj","min","dim","maj","min"], degrees:["I","II","III","IV","V","VI","VII"] },
  lydian:     { intervals:[0,2,4,6,7,9,11], qualities:["maj","maj","min","dim","maj","min","min"], degrees:["I","II","III","IV","V","VI","VII"] },
  mixolydian: { intervals:[0,2,4,5,7,9,10], qualities:["maj","min","dim","maj","min","min","maj"], degrees:["I","II","III","IV","V","VI","VII"] },
  locrian:    { intervals:[0,1,3,5,6,8,10], qualities:["dim","maj","min","min","maj","maj","min"], degrees:["I","II","III","IV","V","VI","VII"] },
};

const SCALE_DESCRIPTIONS = {
  major:      { label:"Major", mood:"Bright and happy", detail:"The foundation of Western music. Used in countless pop, classical, and folk songs." },
  minor:      { label:"Minor", mood:"Dark and expressive", detail:"The natural minor scale. Melancholic and emotional, widely used in rock, classical, and blues." },
  dorian:     { label:"Dorian", mood:"Minor with a raised 6th", detail:"Jazzy and soulful. Like natural minor but brighter — popular in jazz, funk, and Celtic music." },
  phrygian:   { label:"Phrygian", mood:"Dark and exotic", detail:"The lowered 2nd gives a Spanish/flamenco flavor. Intense and dramatic." },
  lydian:     { label:"Lydian", mood:"Dreamy and ethereal", detail:"The raised 4th creates a floating, magical quality. Common in film scores." },
  mixolydian: { label:"Mixolydian", mood:"Bluesy and driving", detail:"Like major but with a flat 7th. The backbone of blues, rock, and funk." },
  locrian:    { label:"Locrian", mood:"Tense and unstable", detail:"Rarely used as a home key due to the diminished tonic chord. Dark and dissonant." },
};

const SEVENTHS_MAJOR = ["maj7","m7","m7","maj7","7","m7","m7b5"];
const SEVENTHS_MINOR = ["m7","m7b5","maj7","m7","m7","maj7","7"];
const SEVENTHS_OTHER = ["m7","m7","maj7","maj7","m7","m7b5","maj7"];
const NINTHS_MAJOR   = ["maj9","m9","m9","maj9","9","m9","m7b5"];
const NINTHS_MINOR   = ["m9","m7b5","maj9","m9","m9","maj9","9"];
const NINTHS_OTHER   = ["m9","m9","maj9","maj9","m9","m7b5","maj9"];

const NOTES        = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const NOTE_DISPLAY = ["C","C#/Db","D","D#/Eb","E","F","F#/Gb","G","G#/Ab","A","A#/Bb","B"];

const CHORD_INTERVALS = {
  // Triads
  maj:[0,4,7], min:[0,3,7], dim:[0,3,6], aug:[0,4,8],
  sus2:[0,2,7], sus4:[0,5,7],
  // Power chord (no 3rd)
  "5":[0,7],
  // 6ths
  "6":[0,4,7,9], m6:[0,3,7,9],
  // 7ths
  maj7:[0,4,7,11], m7:[0,3,7,10], "7":[0,4,7,10], m7b5:[0,3,6,10],
  dim7:[0,3,6,9], aug7:[0,4,8,10], "7sus4":[0,5,7,10],
  // 9ths
  maj9:[0,4,7,11,14], m9:[0,3,7,10,14], "9":[0,4,7,10,14],
  add9:[0,4,7,14], madd9:[0,3,7,14],
  "7b9":[0,4,7,10,13], "7#9":[0,4,7,10,15],
  // 11ths & 13ths
  "11":[0,4,7,10,14,17], maj11:[0,4,7,11,14,17], m11:[0,3,7,10,14,17],
  "13":[0,4,7,10,14,17,21], maj13:[0,4,7,11,14,17,21], m13:[0,3,7,10,14,17,21],
};

const PRESETS = [
  { name:"I–IV–V–I",     degrees:[0,3,4,0] },
  { name:"I–V–vi–IV",    degrees:[0,4,5,3] },
  { name:"ii–V–I",       degrees:[1,4,0]   },
  { name:"I–vi–IV–V",    degrees:[0,5,3,4] },
  { name:"i–VII–VI–VII", degrees:[0,6,5,6] },
];

const FAMOUS_PROGRESSIONS = [
  // ── Pop ──────────────────────────────────────────────────────────
  { name:"Axis of Awesome",        genre:"Pop",     degrees:[0,4,5,3]         }, // I–V–vi–IV
  { name:"50s Progression",        genre:"Pop",     degrees:[0,5,3,4]         }, // I–vi–IV–V
  { name:"Singer-Songwriter",      genre:"Pop",     degrees:[0,2,5,3]         }, // I–iii–vi–IV
  { name:"Pop Ballad",             genre:"Pop",     degrees:[0,2,3,4]         }, // I–iii–IV–V
  { name:"Starts on IV",           genre:"Pop",     degrees:[3,0,4,5]         }, // IV–I–V–vi
  { name:"Uptown Pop",             genre:"Pop",     degrees:[0,3,5,4]         }, // I–IV–vi–V
  { name:"vi Start",               genre:"Pop",     degrees:[5,3,0,4]         }, // vi–IV–I–V
  { name:"vi–V–IV–V",              genre:"Pop",     degrees:[5,4,3,4]         },
  { name:"Power Ballad",           genre:"Pop",     degrees:[0,4,3,0]         }, // I–V–IV–I
  { name:"Optimistic",             genre:"Pop",     degrees:[0,3,0,4]         }, // I–IV–I–V
  { name:"Summer Anthem",          genre:"Pop",     degrees:[0,3,4,3]         }, // I–IV–V–IV
  { name:"ii–IV–I–V",              genre:"Pop",     degrees:[1,3,0,4]         },
  { name:"iii–IV–I–V",             genre:"Pop",     degrees:[2,3,0,4]         },
  { name:"IV–V–vi–I",              genre:"Pop",     degrees:[3,4,5,0]         },
  { name:"Pachelbel Canon",        genre:"Pop",     degrees:[0,4,5,2,3,0,3,4] },
  { name:"Three-Chord Trick",      genre:"Pop",     degrees:[0,3,4]           }, // I–IV–V
  { name:"Two-Chord Groove",       genre:"Pop",     degrees:[0,3]             }, // I–IV loop
  { name:"Building Chorus",        genre:"Pop",     degrees:[0,5,3,4]         },
  { name:"Bittersweet",            genre:"Pop",     degrees:[5,0,3,4]         }, // vi–I–IV–V

  // ── Hip-Hop (Minor) ───────────────────────────────────────────────
  { name:"Trap Loop",              genre:"Hip-Hop", degrees:[0,6]             }, // i–VII
  { name:"Dark Trap",              genre:"Hip-Hop", degrees:[0,5,6,5]         }, // i–VI–VII–VI
  { name:"Sad Trap",               genre:"Hip-Hop", degrees:[0,5,0,6]         }, // i–VI–i–VII
  { name:"Trap Anthem",            genre:"Hip-Hop", degrees:[0,2,5,4]         }, // i–III–VI–V
  { name:"Night Drive",            genre:"Hip-Hop", degrees:[0,6,5,4]         }, // i–VII–VI–V
  { name:"Moody Vamp",             genre:"Hip-Hop", degrees:[0,6,0,5]         }, // i–VII–i–VI
  { name:"Drake Vibes",            genre:"Hip-Hop", degrees:[0,6,5,3]         }, // i–VII–VI–IV
  { name:"Boom Bap",               genre:"Hip-Hop", degrees:[0,3,6,3]         }, // i–iv–VII–iv
  { name:"West Coast Minor",       genre:"Hip-Hop", degrees:[0,5,3,6]         }, // i–VI–IV–VII
  { name:"Street Loop",            genre:"Hip-Hop", degrees:[0,3,6,0]         }, // i–iv–VII–i
  { name:"Melancholy",             genre:"Hip-Hop", degrees:[0,5,2,6]         }, // i–VI–iii°–VII
  { name:"Two-Step Minor",         genre:"Hip-Hop", degrees:[5,6,0]           }, // VI–VII–i
  { name:"Minor Grind",            genre:"Hip-Hop", degrees:[0,6,3,6]         }, // i–VII–iv–VII
  { name:"Sinister",               genre:"Hip-Hop", degrees:[0,1,0,6]         }, // i–ii°–i–VII
  { name:"Cloudy",                 genre:"Hip-Hop", degrees:[0,5,6,2]         }, // i–VI–VII–III
  { name:"Reflective",             genre:"Hip-Hop", degrees:[0,6,5,2]         }, // i–VII–VI–III
  { name:"Introspective",          genre:"Hip-Hop", degrees:[0,5,1,6]         },
  { name:"Trap Anthem II",         genre:"Hip-Hop", degrees:[0,2,6,5]         },
  { name:"Emotional Loop",         genre:"Hip-Hop", degrees:[0,5,6,0]         }, // i–VI–VII–i
  { name:"Minimal Trap",           genre:"Hip-Hop", degrees:[0,3]             }, // i–iv loop
  { name:"Cold Night",             genre:"Hip-Hop", degrees:[0,6,5,6]         }, // i–VII–VI–VII

  // ── R&B & Neo-Soul ────────────────────────────────────────────────
  { name:"Neo-Soul",               genre:"R&B",     degrees:[0,3,1,4]         }, // I–IV–ii–V
  { name:"Smooth R&B",             genre:"R&B",     degrees:[0,5,1,4]         }, // I–vi–ii–V
  { name:"Motown",                 genre:"R&B",     degrees:[0,5,3,4]         }, // I–vi–IV–V
  { name:"Soul Groove",            genre:"R&B",     degrees:[0,3,5,4]         }, // I–IV–vi–V
  { name:"Old School R&B",         genre:"R&B",     degrees:[1,4,0,5]         }, // ii–V–I–vi
  { name:"Slow Jam",               genre:"R&B",     degrees:[0,2,3,5]         }, // I–iii–IV–vi
  { name:"Late Night R&B",         genre:"R&B",     degrees:[0,5,4,3]         }, // I–vi–V–IV
  { name:"Boogaloo",               genre:"R&B",     degrees:[0,3,0,4]         }, // I–IV–I–V
  { name:"Laid-Back Soul",         genre:"R&B",     degrees:[1,3,0,4]         }, // ii–IV–I–V
  { name:"Gospel Feel",            genre:"R&B",     degrees:[3,5,0,4]         }, // IV–vi–I–V

  // ── Jazz & Lo-Fi Hip-Hop ──────────────────────────────────────────
  { name:"ii–V–I",                 genre:"Jazz",    degrees:[1,4,0]           },
  { name:"Rhythm Changes",         genre:"Jazz",    degrees:[0,5,1,4]         }, // I–vi–ii–V
  { name:"ii–V–I–vi",              genre:"Jazz",    degrees:[1,4,0,5]         },
  { name:"Jazz Turnaround",        genre:"Jazz",    degrees:[2,5,1,4]         }, // iii–vi–ii–V
  { name:"I–IV–ii–V",              genre:"Jazz",    degrees:[0,3,1,4]         },
  { name:"Lo-Fi Loop",             genre:"Jazz",    degrees:[0,5,3,1]         }, // I–vi–IV–ii
  { name:"Chill Study",            genre:"Jazz",    degrees:[2,5,0,4]         }, // iii–vi–I–V
  { name:"Rainy Day",              genre:"Jazz",    degrees:[0,2,1,4]         }, // I–iii–ii–V

  // ── Minor (Classic) ───────────────────────────────────────────────
  { name:"Andalusian Cadence",     genre:"Minor",   degrees:[0,6,5,4]         }, // i–VII–VI–V
  { name:"Natural Minor",          genre:"Minor",   degrees:[0,5,2,6]         }, // i–VI–III–VII
  { name:"Minor Cadence",          genre:"Minor",   degrees:[0,3,4,0]         }, // i–iv–V–i
  { name:"Aeolian Loop",           genre:"Minor",   degrees:[0,6,3,5]         }, // i–VII–iv–VI
  { name:"Dorian Groove",          genre:"Minor",   degrees:[0,3,0,4]         }, // i–IV–i–V
  { name:"Phrygian Riff",          genre:"Minor",   degrees:[0,1,0,1]         }, // i–II–i–II

  // ── Rock & Blues ─────────────────────────────────────────────────
  { name:"Classic Rock",           genre:"Rock",    degrees:[0,3,4,0]         }, // I–IV–V–I
  { name:"Power Chord Rock",       genre:"Rock",    degrees:[0,6,3,4]         }, // I–VII–IV–V
  { name:"Blues Shuffle",          genre:"Blues",   degrees:[0,3,4,3]         }, // I–IV–V–IV
  { name:"12-Bar Blues",           genre:"Blues",   degrees:[0,0,3,0,4,3,0,4] },

  // ── Cinematic ─────────────────────────────────────────────────────
  { name:"Epic Rise",              genre:"Film",    degrees:[0,4,5,2]         }, // I–V–vi–iii
  { name:"Cinematic Loop",         genre:"Film",    degrees:[3,0,4,5]         }, // IV–I–V–vi
  { name:"Hans Zimmer",            genre:"Film",    degrees:[0,6,0,6]         }, // I–VII oscillate
  { name:"Hero's Theme",           genre:"Film",    degrees:[0,2,3,4,5,4]     },

  // ── Nordic Pop ────────────────────────────────────────────────────
  { name:"Scandi Melancholy",      genre:"Nordic Pop", degrees:[0,5,3,4]      }, // I–vi–IV–V  (Robyn, Sigrid)
  { name:"Aurora Glow",            genre:"Nordic Pop", degrees:[0,2,5,3]      }, // I–iii–vi–IV (Aurora, Highasakite)
  { name:"Nordic Anthem",          genre:"Nordic Pop", degrees:[0,3,5,4]      }, // I–IV–vi–V  (a-ha style rise)
  { name:"Fjord Drift",            genre:"Nordic Pop", degrees:[5,3,0,4]      }, // vi–IV–I–V  (Susanne Sundfør)
  { name:"Midnight Sun",           genre:"Nordic Pop", degrees:[0,5,3,0]      }, // I–vi–IV–I  (melancholy loop)
  { name:"Polar Night",            genre:"Nordic Pop", degrees:[0,6,5,3]      }, // i–VII–VI–IV (minor Nordic)
  { name:"Scandi Minimal",         genre:"Nordic Pop", degrees:[0,3]          }, // I–IV (minimal loop)
  { name:"Bergen Rain",            genre:"Nordic Pop", degrees:[0,5,1,3]      }, // I–vi–ii–IV (Röyksopp vibe)
  { name:"Nordic Drive",           genre:"Nordic Pop", degrees:[0,3,4,5]      }, // I–IV–V–vi  (building energy)
  { name:"Cold Euphoria",          genre:"Nordic Pop", degrees:[3,4,0,5]      }, // IV–V–I–vi  (chorus lift)
  { name:"Tromsø Lights",          genre:"Nordic Pop", degrees:[0,2,3,5]      }, // I–iii–IV–vi (dreamy)
  { name:"Stockholm Syndrome",     genre:"Nordic Pop", degrees:[5,0,3,4]      }, // vi–I–IV–V  (bittersweet pop)
  { name:"Icy Pulse",              genre:"Nordic Pop", degrees:[0,5,6,3]      }, // i–VI–VII–IV (dark Nordic pop)
  { name:"Ethereal Nord",          genre:"Nordic Pop", degrees:[0,2,5,4]      }, // I–iii–vi–V  (wide open)

  // ── Radiohead / Art Rock ──────────────────────────────────────────
  { name:"Creep",                  genre:"Radiohead", degrees:[0,2,3,3]       }, // I–III–IV–iv (major→minor IV)
  { name:"Paranoid Android",       genre:"Radiohead", degrees:[0,6,5,4]       }, // i–VII–VI–V (Andalusian w/ edge)
  { name:"OK Computer",            genre:"Radiohead", degrees:[0,1,5,6]       }, // i–ii°–VI–VII (dissonant minor)
  { name:"Kid A Drift",            genre:"Radiohead", degrees:[0,5,6,5]       }, // i–VI–VII–VI (hypnotic minor)
  { name:"In Rainbows",            genre:"Radiohead", degrees:[0,2,5,3]       }, // I–iii–vi–IV (warm but complex)
  { name:"Amnesiac",               genre:"Radiohead", degrees:[0,1,0,6]       }, // i–ii°–i–VII (dark, uneasy)
  { name:"Exit Music",             genre:"Radiohead", degrees:[0,6,3,4]       }, // i–VII–iv–V  (cinematic minor)
  { name:"No Surprises",           genre:"Radiohead", degrees:[0,3,5,1]       }, // I–IV–vi–ii  (deceptive sweetness)
  { name:"Weird Fishes",           genre:"Radiohead", degrees:[0,2,3,5,4,2]   }, // I–iii–IV–vi–V–iii (long form)
  { name:"Identikit",              genre:"Radiohead", degrees:[0,6,5,2]       }, // i–VII–VI–III (modal interchange)
  { name:"Bloom",                  genre:"Radiohead", degrees:[0,3,6,5]       }, // i–iv–VII–VI (polyrhythmic feel)
  { name:"Daydreaming",            genre:"Radiohead", degrees:[0,5,0,6]       }, // i–VI–i–VII  (sparse, haunting)
  { name:"Lucky",                  genre:"Radiohead", degrees:[0,5,3,4]       }, // I–vi–IV–V   (hopeful Radiohead)
  { name:"Street Spirit",          genre:"Radiohead", degrees:[0,2,5,6]       }, // i–III–VI–VII (arpeggio-driven)

  // ── Soul ──────────────────────────────────────────────────────────
  { name:"Classic Soul",           genre:"Soul",    degrees:[0,3,1,4]         }, // I–IV–ii–V
  { name:"Stevie Wonder",          genre:"Soul",    degrees:[0,3,5,4]         }, // I–IV–vi–V
  { name:"Marvin Gaye",            genre:"Soul",    degrees:[0,5,1,4]         }, // I–vi–ii–V
  { name:"Soul Ballad",            genre:"Soul",    degrees:[0,2,3,5]         }, // I–iii–IV–vi
  { name:"Aretha Feel",            genre:"Soul",    degrees:[0,3,0,4]         }, // I–IV–I–V
  { name:"Otis Groove",            genre:"Soul",    degrees:[1,4,0,5]         }, // ii–V–I–vi
  { name:"Memphis Slow",           genre:"Soul",    degrees:[0,5,3,1]         }, // I–vi–IV–ii
  { name:"Northern Soul",          genre:"Soul",    degrees:[3,5,0,4]         }, // IV–vi–I–V
  { name:"Deep Soul",              genre:"Soul",    degrees:[0,3,5,4,1,4]     }, // I–IV–vi–V–ii–V
  { name:"Soul Kitchen",           genre:"Soul",    degrees:[0,5,4,3]         }, // I–vi–V–IV

  // ── Dark / Minor ──────────────────────────────────────────────────
  { name:"Descent",                genre:"Dark",    degrees:[0,6,5,4]         }, // i–VII–VI–V (Andalusian)
  { name:"Void",                   genre:"Dark",    degrees:[0,1,0,6]         }, // i–bII–i–VII (Phrygian darkness)
  { name:"Abyss",                  genre:"Dark",    degrees:[0,5,1,0]         }, // i–VI–bII–i (crushing return)
  { name:"Paranoia",               genre:"Dark",    degrees:[0,1,3,0]         }, // i–bII–iv–i (claustrophobic)
  { name:"Requiem",                genre:"Dark",    degrees:[0,4,3,0]         }, // i–V–iv–i (minor cadence)
  { name:"Obsidian",               genre:"Dark",    degrees:[0,3,6,5]         }, // i–iv–VII–VI (noir feel)
  { name:"Graveyard Shift",        genre:"Dark",    degrees:[0,6,3,1]         }, // i–VII–iv–bII (dark trap)
  { name:"Nattsvart",              genre:"Dark",    degrees:[0,5,6,1]         }, // i–VI–VII–bII (Nordic noir)
  { name:"Witch House",            genre:"Dark",    degrees:[0,1,5,6]         }, // i–bII–VI–VII (occult)
  { name:"Sleep Paralysis",        genre:"Dark",    degrees:[0,1,0,5]         }, // i–bII–i–VI (frozen dread)
  { name:"Undertow",               genre:"Dark",    degrees:[0,6,1,6]         }, // i–VII–bII–VII (pulling down)
  { name:"Last Light",             genre:"Dark",    degrees:[0,5,3,6]         }, // i–VI–iv–VII (fading hope)
  { name:"Black Ice",              genre:"Dark",    degrees:[0,3,1,6]         }, // i–iv–bII–VII (Scandinavian)
  { name:"Hollow",                 genre:"Dark",    degrees:[0,5,0,1]         }, // i–VI–i–bII (empty, desolate)
  { name:"Endless Tunnel",         genre:"Dark",    degrees:[0,6,0,6]         }, // i–VII–i–VII (hypnotic dark)
  { name:"Buried Alive",           genre:"Dark",    degrees:[0,1,6,5]         }, // i–bII–VII–VI (descending terror)
];

// ═══════════════════════════════════════════════════════════════════════════
// ─── DRUM MACHINE ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// 14 tracks — focused on what matters for hip-hop / boom-bap / trap
// Default MIDI notes match original pad positions on MPC (A1=36, A2=37, ...)
// ghostKick uses A13 (note 48, formerly bell) to avoid shifting existing mappings
const DRUM_TRACKS = [
  { id:"kick",      label:"Kick",       defaultPad:"A1",  defaultNote:36 },
  { id:"ghostKick", label:"Ghost Kick", defaultPad:"A13", defaultNote:48 },
  { id:"snare",     label:"Snare",      defaultPad:"A2",  defaultNote:37 },
  { id:"ghost",     label:"Ghost Sn",   defaultPad:"A4",  defaultNote:39 },
  { id:"clap",      label:"Clap",       defaultPad:"A5",  defaultNote:40 },
  { id:"hatC",      label:"Hat (C)",    defaultPad:"A3",  defaultNote:38 },
  { id:"hatO",      label:"Hat (O)",    defaultPad:"A9",  defaultNote:44 },
  { id:"rim",       label:"Rim",        defaultPad:"A6",  defaultNote:41 },
  { id:"tom",       label:"Tom",        defaultPad:"A7",  defaultNote:42 },
  { id:"low808",    label:"808",        defaultPad:"A8",  defaultNote:43 },
  { id:"shaker",    label:"Shaker",     defaultPad:"A11", defaultNote:46 },
  { id:"perc",      label:"Perc",       defaultPad:"A12", defaultNote:47 },
  { id:"ride",      label:"Ride",       defaultPad:"A10", defaultNote:45 },
  { id:"crash",     label:"Crash",      defaultPad:"A16", defaultNote:51 },
];

const DRUM_STEPS = 64;       // 4 bars × 16 sixteenth-notes
const DRUM_BAR_STEPS = 16;
function emptyDrumTrack() { return new Array(DRUM_STEPS).fill(0); }

// ── Deterministic density with musical importance scoring ──
// Hash gives small random jitter so notes at similar importance don't all vanish at once
function densityHash(seed, trackId, step) {
  let h = seed ^ 0x5f3759df;
  for (let i = 0; i < trackId.length; i++) h = ((h << 5) - h + trackId.charCodeAt(i)) | 0;
  h = ((h << 5) - h + step) | 0;
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b); h ^= h >>> 16;
  return (h >>> 0) / 0xffffffff; // 0..1
}

// ── Musical importance scores (0–1) — higher = removed last ──

// Drum importance: considers track role + metric position
function drumImportance(trackId, step) {
  const bar16 = step % 16;
  // Metric position weight
  let pos;
  if (bar16 === 0)                          pos = 1.0;   // beat 1 (strongest)
  else if (bar16 === 8)                     pos = 0.9;   // beat 3
  else if (bar16 === 4 || bar16 === 12)     pos = 0.85;  // beats 2, 4 (backbeats)
  else if (bar16 % 4 === 0)                 pos = 0.7;   // other quarters
  else if (bar16 % 2 === 0)                 pos = 0.5;   // 8ths
  else                                      pos = 0.3;   // 16ths

  // Track role weight — core groove elements higher
  const TRACK_WEIGHT = {
    kick: 1.0, snare: 0.95, clap: 0.85, low808: 0.8,
    hatC: 0.65, hatO: 0.55, rim: 0.5, ride: 0.48,
    tom: 0.45, crash: 0.42, shaker: 0.35, perc: 0.3,
    ghostKick: 0.25, ghost: 0.2,
  };
  const track = TRACK_WEIGHT[trackId] ?? 0.5;

  return track * 0.55 + pos * 0.45;
}

// Bass importance: downbeats + longer notes more important
function bassImportance(startSlot, lengthSlots) {
  const bar16 = startSlot % 16;
  let pos;
  if (bar16 === 0)        pos = 1.0;
  else if (bar16 === 8)   pos = 0.8;
  else if (bar16 % 4 === 0) pos = 0.6;
  else if (bar16 % 2 === 0) pos = 0.4;
  else                    pos = 0.25;
  const len = Math.min(1, lengthSlots / 8); // half-bar note = max
  return pos * 0.65 + len * 0.35;
}

// Melody importance: position + duration + velocity
function melodyImportance(startSlot, lengthSlots, velocity) {
  const bar16 = startSlot % 16;
  let pos;
  if (bar16 === 0)        pos = 1.0;
  else if (bar16 === 8)   pos = 0.8;
  else if (bar16 % 4 === 0) pos = 0.6;
  else if (bar16 % 2 === 0) pos = 0.4;
  else                    pos = 0.25;
  const len = Math.min(1, lengthSlots / 4);
  const vel = (velocity || 100) / 127;
  return pos * 0.5 + len * 0.25 + vel * 0.25;
}

// Chord note importance: root > third > fifth > extensions
function chordNoteImportance(indexInChord, totalNotes) {
  if (indexInChord === 0) return 1.0; // root — never remove
  if (totalNotes <= 3) {
    // Triad: root(1.0) → third(0.65) → fifth(0.45)
    return indexInChord === 1 ? 0.65 : 0.45;
  }
  // 4+ notes: root → third → fifth → 7th → extensions
  if (indexInChord === 1) return 0.65; // third (defines quality)
  if (indexInChord === 2) return 0.45; // fifth
  return Math.max(0.15, 0.35 - (indexInChord - 3) * 0.1); // 7th, 9th, etc.
}

// Master density gate: importance vs threshold + small random jitter
function densityPass(seed, trackId, step, density, importance) {
  if (density >= 100) return true;
  if (density <= 0) return false;
  const threshold = 1 - density / 100; // density 100→0, threshold 0→1
  const jitter = (densityHash(seed, trackId, step) - 0.5) * 0.15; // ±7.5% randomness
  return (importance + jitter) >= threshold;
}

// ── Loop Variation: deterministic mutations applied at schedule time ──
// Deterministic variation hash — same seed+step always gives same mutation
function variationHash(seed, id, step) {
  let h = seed ^ 0x3c6ef372;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  h = ((h << 5) - h + step) | 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 16;
  return (h >>> 0) / 0xffffffff; // 0..1
}

// Drum velocity variation: ±35% at full variation, biased toward subtle changes
function varDrumVelocity(seed, trackId, step, originalVel, amount) {
  if (amount <= 0 || originalVel <= 0) return originalVel;
  const r = variationHash(seed, trackId, step);
  const range = (amount / 100) * 0.35; // up to ±35% at max
  const delta = (r - 0.5) * 2 * range;
  return Math.max(1, Math.min(127, Math.round(originalVel * (1 + delta))));
}

// Drum ghost note: occasionally add a quiet hit where there was none
// Returns velocity (0 = don't add) — only triggers when variation is high enough
// prevStepHasHit: whether the previous step already has a note (prevents rapid-fire)
function varDrumGhost(seed, trackId, step, amount, prevStepHasHit) {
  if (amount < 30) return 0; // need at least 30% for ghosts
  // Prevent consecutive hits — no ghost if previous step had a note
  if (prevStepHasHit) return 0;
  // Track-specific probability: snare/clap get far fewer ghosts than hats
  const trackScale = (trackId === "snare" || trackId === "clap" || trackId === "rim") ? 0.25
    : (trackId === "kick") ? 0.35
    : (trackId === "crash" || trackId === "ride") ? 0.3
    : 1.0; // hats, perc, etc. can have more
  const r = variationHash(seed, trackId + "_ghost", step);
  const baseChance = ((amount - 30) / 70) * 0.08 * trackScale; // max 8% * trackScale
  if (r > baseChance) return 0;
  // Ghost velocity: 15-30 (very quiet)
  return Math.round(15 + variationHash(seed, trackId + "_gv", step) * 15);
}

// Drum rest: occasionally skip a note (replace with silence)
function varDrumRest(seed, trackId, step, amount, importance) {
  if (amount < 30) return false; // need 30% for occasional rests
  // Never rest on highly important beats (kick on 1, snare on 5)
  if (importance > 0.85) return false;
  const r = variationHash(seed, trackId + "_rest", step);
  const threshold = 1 - ((amount - 30) / 70) * 0.08; // max 8% chance
  return r > threshold ? false : true;
}

// Bass octave variation: occasionally shift bass note up/down an octave
function varBassOctave(seed, step, amount) {
  if (amount < 25) return 0;
  const r = variationHash(seed, "bass_oct", step);
  const chance = ((amount - 25) / 75) * 0.15; // max 15% chance
  if (r > chance) return 0;
  // 70% chance up, 30% chance down
  return variationHash(seed, "bass_dir", step) > 0.3 ? 12 : -12;
}

// Melody velocity variation
function varMelodyVelocity(seed, step, originalVel, amount) {
  if (amount <= 0) return originalVel;
  const r = variationHash(seed, "mel_vel", step);
  const range = (amount / 100) * 0.25;
  const delta = (r - 0.5) * 2 * range;
  return Math.max(1, Math.min(127, Math.round(originalVel * (1 + delta))));
}

// Chord strum variation: vary the strum offset timing
function varStrumOffset(seed, step, noteIdx, amount) {
  if (amount <= 0) return 0;
  const r = variationHash(seed, "strum" + noteIdx, step);
  const maxMs = (amount / 100) * 25; // up to 25ms strum variation
  return (r - 0.5) * 2 * maxMs;
}

// ── MPC Pad ↔ MIDI note mapping ──
// MPC banks: A=36-51, B=52-67, C=68-83, D=84-99
const MPC_BANKS = ["A","B","C","D"];
const MPC_PADS = [];
MPC_BANKS.forEach((bank, bi) => {
  for (let p = 1; p <= 16; p++) {
    MPC_PADS.push({ label: `${bank}${p}`, midi: 36 + bi * 16 + (p - 1) });
  }
});
const midiToPadLabel = (midi) => {
  const entry = MPC_PADS.find(p => p.midi === midi);
  return entry ? entry.label : `N${midi}`;
};
const padLabelToMidi = (label) => {
  const entry = MPC_PADS.find(p => p.label === label);
  return entry ? entry.midi : 36;
};

// ── Energy scaling ──
// Maps energy (0-100) to velocity multiplier and density offset.
// At 75 (default): velMult = 1.0, densityOffset = 0 (neutral).
function energyScale(energy) {
  const t = energy / 100;
  let velMult, densityOffset;
  if (t <= 0.75) {
    const s = t / 0.75; // 0..1 mapped to energy 0..75
    velMult = 0.25 + s * 0.75; // 0.25 → 1.0
    densityOffset = -50 * (1 - s); // -50 → 0
  } else {
    const s = (t - 0.75) / 0.25; // 0..1 mapped to energy 75..100
    velMult = 1.0 + s * 0.2; // 1.0 → 1.2
    densityOffset = s * 10; // 0 → 10
  }
  return { velMult, densityOffset };
}

// ── Pad Map Presets ──
const PAD_MAP_PRESETS = [
  { id:"default", label:"Fiskaturet Default", desc:"A1-A14 chromatic",
    map: DRUM_TRACKS.reduce((a,t) => ({...a,[t.id]:{padId:t.defaultPad, midiNote:t.defaultNote}}),{}) },
  { id:"gm", label:"General MIDI", desc:"Standard GM drum map",
    map: { kick:{padId:"A1",midiNote:36}, ghostKick:{padId:"A1",midiNote:36}, snare:{padId:"A3",midiNote:38},
           ghost:{padId:"A5",midiNote:40}, clap:{padId:"A4",midiNote:39}, hatC:{padId:"A7",midiNote:42},
           hatO:{padId:"A11",midiNote:46}, rim:{padId:"A2",midiNote:37}, tom:{padId:"A10",midiNote:45},
           low808:{padId:"A1",midiNote:36}, shaker:{padId:"B11",midiNote:70}, perc:{padId:"B16",midiNote:67},
           ride:{padId:"A16",midiNote:51}, crash:{padId:"A14",midiNote:49} }},
  { id:"mpc_classic", label:"MPC Chromatic", desc:"A1-A14 straight chromatic",
    map: { kick:{padId:"A1",midiNote:36}, ghostKick:{padId:"A2",midiNote:37}, snare:{padId:"A3",midiNote:38},
           ghost:{padId:"A4",midiNote:39}, clap:{padId:"A5",midiNote:40}, hatC:{padId:"A6",midiNote:41},
           hatO:{padId:"A7",midiNote:42}, rim:{padId:"A8",midiNote:43}, tom:{padId:"A9",midiNote:44},
           low808:{padId:"A10",midiNote:45}, shaker:{padId:"A11",midiNote:46}, perc:{padId:"A12",midiNote:47},
           ride:{padId:"A13",midiNote:48}, crash:{padId:"A14",midiNote:49} }},
];

const D_PROB = (p) => Math.random() < p;
const D_PICK = (arr) => arr[Math.floor(Math.random()*arr.length)];
const D_VEL  = (base, jitter=20) => Math.max(1, Math.min(127, base + Math.floor((Math.random()-0.5)*jitter*2)));

function compose4Bars(barFn) {
  const out = new Array(DRUM_STEPS).fill(0);
  for (let b=0; b<4; b++) {
    const bar = barFn(b);
    for (let i=0; i<DRUM_BAR_STEPS; i++) out[b*DRUM_BAR_STEPS+i] = bar[i] || 0;
  }
  return out;
}

function sprinkleGhosts(track, density=0.12, vel=35) {
  for (let i=0; i<track.length; i++) {
    if (track[i]===0 && i%4 !== 0 && D_PROB(density)) track[i] = D_VEL(vel, 10);
  }
}

// ─── Genre generators ──────────────────────────────────────────────────────

function genBoomBapClassic() {
  const tracks = {};
  const KICKS = [
    [110,0,0,0, 0,0,0,0, 0,0,110,0, 0,0,0,0],
    [110,0,0,0, 0,0,0,0, 110,0,0,0, 0,0,0,0],
    [110,0,0,0, 0,0,0,110, 0,0,110,0, 0,0,0,0],
    [110,0,0,0, 0,0,110,0, 0,0,110,0, 0,0,0,0],
    [110,0,0,0, 0,0,0,0, 0,0,110,0, 0,0,110,0],
  ];
  tracks.kick  = compose4Bars(() => D_PICK(KICKS).slice());
  tracks.snare = compose4Bars(() => [0,0,0,0, 105,0,0,0, 0,0,0,0, 105,0,0,0]);
  tracks.hatC  = emptyDrumTrack();
  for (let i=0; i<DRUM_STEPS; i++) {
    if (i%2===0) tracks.hatC[i] = D_VEL(75, 15);
    else if (D_PROB(0.18)) tracks.hatC[i] = D_VEL(45, 10);
  }
  tracks.ghost = emptyDrumTrack();
  sprinkleGhosts(tracks.ghost, 0.08, 30);
  // Ghost kicks — soft kicks before/after main kicks
  tracks.ghostKick = emptyDrumTrack();
  for (let i=0; i<DRUM_STEPS; i++) {
    if (tracks.kick[i] > 0 && i > 0 && tracks.kick[i-1] === 0 && D_PROB(0.25)) tracks.ghostKick[i-1] = D_VEL(45, 10);
    if (tracks.kick[i] > 0 && i < DRUM_STEPS-1 && tracks.kick[i+1] === 0 && D_PROB(0.15)) tracks.ghostKick[i+1] = D_VEL(40, 10);
  }
  return tracks;
}

function genGriselda() {
  const tracks = {};
  const KICKS = [
    [110,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
    [110,0,0,0, 0,0,0,0, 110,0,0,0, 0,0,0,0],
    [110,0,0,0, 0,0,0,0, 0,0,110,0, 0,0,0,0],
  ];
  tracks.kick  = compose4Bars(() => D_PICK(KICKS).slice());
  tracks.snare = compose4Bars(() => [0,0,0,0, 0,0,0,0, 100,0,0,0, 0,0,0,0]);
  tracks.hatC  = emptyDrumTrack();
  for (let i=0; i<DRUM_STEPS; i++) {
    if (i%4===0 && D_PROB(0.6)) tracks.hatC[i] = D_VEL(60, 15);
    else if (D_PROB(0.08)) tracks.hatC[i] = D_VEL(40, 10);
  }
  tracks.rim = emptyDrumTrack();
  for (let i=0; i<DRUM_STEPS; i++) if (i%16===14 && D_PROB(0.5)) tracks.rim[i] = D_VEL(70);
  // Ghost kicks — rare, menacing
  tracks.ghostKick = emptyDrumTrack();
  for (let i=0; i<DRUM_STEPS; i++) {
    if (tracks.kick[i] === 0 && i%4===2 && D_PROB(0.12)) tracks.ghostKick[i] = D_VEL(35, 8);
  }
  return tracks;
}

function genTrapModern() {
  const tracks = {};
  const KICKS = [
    [120,0,0,0, 0,0,120,0, 0,0,0,0, 120,0,0,0],
    [120,0,0,0, 0,0,0,0, 120,0,0,0, 0,0,120,0],
    [120,0,0,0, 0,0,0,120, 0,0,120,0, 0,0,0,0],
  ];
  tracks.kick = compose4Bars(() => D_PICK(KICKS).slice());
  tracks.clap = compose4Bars(() => [0,0,0,0, 0,0,0,0, 110,0,0,0, 0,0,0,0]);
  tracks.hatC = emptyDrumTrack();
  for (let i=0; i<DRUM_STEPS; i++) {
    tracks.hatC[i] = D_VEL(70, 20);
    if (i%4===0) tracks.hatC[i] = D_VEL(85, 10);
  }
  // Roll bursts at end of bar 2 and bar 4
  tracks.hatC[14] = D_VEL(85); tracks.hatC[15] = D_VEL(95);
  tracks.hatC[46] = D_VEL(85); tracks.hatC[47] = D_VEL(95);
  tracks.low808 = tracks.kick.map(v => v > 0 && D_PROB(0.85) ? D_VEL(110) : 0);
  return tracks;
}

function genLofi() {
  const tracks = {};
  const KICKS = [
    [105,0,0,0, 0,0,0,0, 0,0,105,0, 0,0,0,0],
    [105,0,0,0, 0,0,0,105, 0,0,105,0, 0,0,0,0],
    [105,0,0,0, 0,0,105,0, 0,0,0,0, 0,0,0,0],
  ];
  tracks.kick  = compose4Bars(() => D_PICK(KICKS).slice());
  tracks.snare = compose4Bars(() => [0,0,0,0, 90,0,0,0, 0,0,0,0, 90,0,0,0]);
  tracks.hatC  = emptyDrumTrack();
  for (let i=0; i<DRUM_STEPS; i++) {
    if (i%2===0) tracks.hatC[i] = D_VEL(65, 15);
    else if (D_PROB(0.25)) tracks.hatC[i] = D_VEL(40, 8);
  }
  tracks.ghost = emptyDrumTrack();
  sprinkleGhosts(tracks.ghost, 0.18, 28);
  tracks.shaker = emptyDrumTrack();
  for (let i=0; i<DRUM_STEPS; i++) if (i%2===1) tracks.shaker[i] = D_VEL(50, 10);
  // Ghost kicks — lazy, swung feel
  tracks.ghostKick = emptyDrumTrack();
  for (let i=0; i<DRUM_STEPS; i++) {
    if (tracks.kick[i] > 0 && i < DRUM_STEPS-1 && tracks.kick[i+1] === 0 && D_PROB(0.3)) tracks.ghostKick[i+1] = D_VEL(35, 8);
  }
  return tracks;
}

function genDetroit() {
  const tracks = {};
  const KICKS = [
    [110,0,0,110, 0,0,0,0, 0,0,110,0, 0,0,0,0],
    [110,0,0,0, 0,0,0,0, 0,110,110,0, 0,0,0,0],
    [110,0,110,0, 0,0,0,0, 0,0,110,0, 0,0,0,0],
  ];
  tracks.kick  = compose4Bars(() => D_PICK(KICKS).slice());
  tracks.snare = compose4Bars(() => [0,0,0,0, 100,0,0,0, 0,0,0,0, 100,0,0,0]);
  tracks.ghost = emptyDrumTrack();
  sprinkleGhosts(tracks.ghost, 0.25, 35);
  tracks.hatC  = emptyDrumTrack();
  for (let i=0; i<DRUM_STEPS; i++) {
    if (i%4===0) tracks.hatC[i] = D_VEL(80, 15);
    else if (i%2===0) tracks.hatC[i] = D_VEL(60, 15);
    else if (D_PROB(0.4)) tracks.hatC[i] = D_VEL(45, 10);
  }
  // Ghost kicks — Detroit bounce
  tracks.ghostKick = emptyDrumTrack();
  for (let i=0; i<DRUM_STEPS; i++) {
    if (tracks.kick[i] === 0 && i%2===1 && D_PROB(0.2)) tracks.ghostKick[i] = D_VEL(40, 10);
  }
  return tracks;
}

function genMemphisPhonk() {
  const tracks = {};
  const KICKS = [
    [115,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
    [115,0,0,0, 0,0,0,0, 115,0,0,0, 0,0,0,0],
  ];
  tracks.kick  = compose4Bars(() => D_PICK(KICKS).slice());
  tracks.snare = compose4Bars(() => [0,0,0,0, 0,0,0,0, 100,0,0,0, 0,0,0,0]);
  tracks.ride  = emptyDrumTrack();
  // Approximate triplet feel with 6-step interval (close enough on 16-grid)
  for (let i=0; i<DRUM_STEPS; i++) {
    if (i%6===0) tracks.ride[i] = D_VEL(70, 15);
    else if (i%6===3) tracks.ride[i] = D_VEL(60, 15);
  }
  tracks.rim = emptyDrumTrack();
  for (let i=0; i<DRUM_STEPS; i++) if (i%16===10 && D_PROB(0.5)) tracks.rim[i] = D_VEL(75);
  tracks.low808 = tracks.kick.map(v => v > 0 ? D_VEL(120) : 0);
  return tracks;
}

function genDrill() {
  const tracks = {};
  const KICKS = [
    [120,0,0,0, 0,0,120,0, 0,120,0,0, 0,0,0,0],
    [120,0,0,0, 0,0,0,120, 0,0,120,0, 0,0,0,0],
  ];
  tracks.kick  = compose4Bars(() => D_PICK(KICKS).slice());
  tracks.snare = compose4Bars(() => [0,0,0,0, 0,0,0,0, 110,0,0,0, 0,0,0,0]);
  tracks.hatC  = emptyDrumTrack();
  for (let i=0; i<DRUM_STEPS; i++) {
    const inGap = (i % 16 >= 8 && i % 16 < 10);
    if (!inGap) {
      if (i%2===0) tracks.hatC[i] = D_VEL(70, 15);
      else if (D_PROB(0.5)) tracks.hatC[i] = D_VEL(50, 10);
    }
  }
  tracks.low808 = tracks.kick.map(v => v > 0 ? D_VEL(115) : 0);
  return tracks;
}

function genExperimental() {
  const tracks = {};
  tracks.kick = emptyDrumTrack();
  for (let i=0; i<DRUM_STEPS; i++) {
    if (i===0 || i===32) tracks.kick[i] = D_VEL(110);
    else if (D_PROB(0.06)) tracks.kick[i] = D_VEL(105);
  }
  tracks.snare = emptyDrumTrack();
  [12, 28, 44, 60].forEach(p => {
    const j = p + Math.floor((Math.random()-0.5)*3);
    if (j>=0 && j<DRUM_STEPS) tracks.snare[j] = D_VEL(95);
  });
  tracks.perc = emptyDrumTrack();
  for (let i=0; i<DRUM_STEPS; i++) if (D_PROB(0.12)) tracks.perc[i] = D_VEL(60, 20);
  // Ghost kicks — random scattered
  tracks.ghostKick = emptyDrumTrack();
  for (let i=0; i<DRUM_STEPS; i++) if (tracks.kick[i] === 0 && D_PROB(0.06)) tracks.ghostKick[i] = D_VEL(40, 15);
  return tracks;
}

function genDrumless() {
  const tracks = {};
  tracks.kick = compose4Bars(() => {
    const k = new Array(16).fill(0);
    k[0] = 110;
    if (D_PROB(0.7)) k[8] = 110;
    return k;
  });
  tracks.snare = compose4Bars(() => {
    const s = new Array(16).fill(0);
    s[4] = 100; s[12] = 100;
    return s;
  });
  return tracks;
}

function genHalftime() {
  const tracks = {};
  const KICKS = [
    [110,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
    [110,0,0,0, 0,0,0,0, 0,0,110,0, 0,0,0,0],
    [110,0,0,0, 0,0,0,110, 0,0,0,0, 0,0,0,0],
  ];
  tracks.kick  = compose4Bars(() => D_PICK(KICKS).slice());
  tracks.snare = compose4Bars(() => [0,0,0,0, 0,0,0,0, 100,0,0,0, 0,0,0,0]);
  tracks.hatO  = emptyDrumTrack();
  for (let i=0; i<DRUM_STEPS; i++) if (i%8===6 && D_PROB(0.6)) tracks.hatO[i] = D_VEL(65, 10);
  tracks.perc = emptyDrumTrack();
  for (let i=0; i<DRUM_STEPS; i++) if (D_PROB(0.08)) tracks.perc[i] = D_VEL(45, 15);
  return tracks;
}

const DRUM_GENRES = {
  boombap_classic: { label:"Boom Bap Klassisk",   bpm:90,  generate: genBoomBapClassic },
  griselda:        { label:"Griselda",            bpm:84,  generate: genGriselda       },
  trap_modern:     { label:"Moderne Trap",        bpm:140, generate: genTrapModern     },
  lofi:            { label:"Lo-fi",               bpm:78,  generate: genLofi           },
  detroit:         { label:"Detroit",             bpm:92,  generate: genDetroit        },
  memphis:         { label:"Memphis/Phonk",       bpm:75,  generate: genMemphisPhonk   },
  drill:           { label:"Drill",               bpm:140, generate: genDrill          },
  experimental:    { label:"Eksperimentell",      bpm:88,  generate: genExperimental   },
  drumless:        { label:"Drumless",            bpm:88,  generate: genDrumless       },
  halftime:        { label:"Halftime",             bpm:75,  generate: genHalftime       },
};

// ── Drum Fill Generators ──

function generateFill(genre) {
  const fills = FILL_PATTERNS[genre] || FILL_PATTERNS._default;
  return fills[Math.floor(Math.random() * fills.length)]();
}

const FILL_PATTERNS = {
  _default: [
    // Snare roll — building snare hits getting louder
    () => {
      const fill = {};
      fill.snare = [0,0,0,0, 80,0,80,0, 90,90,95,95, 100,105,110,115];
      fill.kick = [100,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,110];
      fill.crash = [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0]; // crash goes on beat 1 of NEXT bar
      fill.hatC = [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0]; // silence hats during fill
      fill.hatO = [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0];
      return fill;
    },
    // Tom descent — high to low toms with snare accents
    () => {
      const fill = {};
      fill.tom = [0,0,0,0, 95,0,90,0, 85,0,80,0, 75,0,70,0];
      fill.snare = [0,0,0,0, 0,100,0,100, 0,0,0,0, 110,0,110,115];
      fill.kick = [100,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,100];
      fill.hatC = [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0];
      return fill;
    },
    // Rapid snare build
    () => {
      const fill = {};
      fill.snare = [0,0,0,0, 0,0,0,0, 85,0,90,0, 95,100,105,110];
      fill.kick = [110,0,0,0, 0,0,0,0, 100,0,0,0, 0,0,0,110];
      fill.hatC = [70,0,70,0, 0,0,0,0, 0,0,0,0, 0,0,0,0];
      return fill;
    },
  ],
  boombap_classic: [
    // Classic boom bap fill — snare flams and kick accents
    () => {
      const fill = {};
      fill.snare = [0,0,0,0, 95,0,0,90, 0,100,0,0, 95,100,105,110];
      fill.kick = [110,0,0,0, 0,0,0,0, 100,0,0,0, 0,0,0,100];
      fill.ghost = [0,40,0,0, 0,35,40,0, 0,0,35,40, 0,0,0,0];
      fill.hatC = [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0];
      return fill;
    },
    () => {
      const fill = {};
      fill.snare = [0,0,0,0, 100,0,95,0, 100,0,100,100, 105,105,110,115];
      fill.kick = [110,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,110];
      fill.hatC = [70,70,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0];
      return fill;
    },
  ],
  griselda: [
    () => {
      const fill = {};
      fill.snare = [0,0,0,0, 0,0,100,0, 0,100,0,100, 105,0,110,115];
      fill.kick = [100,0,0,0, 0,0,0,0, 100,0,0,0, 0,0,0,0];
      fill.rim = [0,0,0,70, 0,0,0,0, 0,0,0,0, 0,0,0,0];
      fill.hatC = [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0];
      return fill;
    },
  ],
  trap_modern: [
    // Trap fill — rapid hi-hat + snare rolls
    () => {
      const fill = {};
      fill.hatC = [90,90,95,95, 100,100,105,105, 110,110,110,110, 115,115,115,115];
      fill.snare = [0,0,0,0, 0,0,0,0, 0,0,100,0, 105,0,110,115];
      fill.kick = [110,0,0,0, 0,0,0,0, 0,0,0,0, 110,0,0,0];
      return fill;
    },
    () => {
      const fill = {};
      fill.hatC = [85,0,85,85, 90,0,90,90, 95,95,95,95, 100,100,105,110];
      fill.snare = [0,0,0,0, 100,0,0,0, 0,0,100,0, 100,100,110,115];
      fill.kick = [110,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,110];
      return fill;
    },
  ],
  drill: [
    () => {
      const fill = {};
      fill.hatC = [95,95,100,100, 105,105,105,105, 110,110,110,110, 115,115,115,115];
      fill.snare = [0,0,0,0, 0,0,0,0, 100,0,0,0, 105,105,110,115];
      fill.kick = [110,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,100];
      return fill;
    },
  ],
  lofi: [
    () => {
      const fill = {};
      fill.snare = [0,0,0,0, 70,0,0,75, 0,80,0,0, 85,0,90,95];
      fill.kick = [90,0,0,0, 0,0,0,0, 80,0,0,0, 0,0,0,0];
      fill.hatC = [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0];
      fill.ghost = [0,30,0,30, 0,0,35,0, 0,0,30,35, 0,35,0,0];
      return fill;
    },
  ],
  memphis: [
    () => {
      const fill = {};
      fill.hatC = [90,90,90,90, 95,95,95,95, 100,100,100,100, 110,110,110,110];
      fill.snare = [0,0,0,0, 0,0,0,0, 100,0,0,0, 0,100,105,110];
      fill.kick = [110,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,110];
      return fill;
    },
  ],
  detroit: [
    () => {
      const fill = {};
      fill.snare = [0,0,0,0, 90,0,85,0, 95,0,95,100, 105,105,110,110];
      fill.kick = [100,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,100];
      fill.hatC = [60,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0];
      return fill;
    },
  ],
  experimental: [
    () => {
      const fill = {};
      fill.perc = [0,70,0,75, 80,0,85,0, 0,90,0,0, 95,0,100,105];
      fill.snare = [0,0,0,0, 0,0,0,90, 0,0,100,0, 0,105,0,110];
      fill.kick = [100,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,100];
      fill.hatC = [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0];
      return fill;
    },
  ],
  halftime: [
    () => {
      const fill = {};
      fill.snare = [0,0,0,0, 0,0,0,0, 85,0,0,0, 95,0,105,110];
      fill.kick = [100,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0];
      fill.tom = [0,0,0,0, 80,0,0,0, 0,0,70,0, 0,0,0,0];
      fill.hatC = [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0];
      return fill;
    },
  ],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BLACK_KEY_INDICES = new Set([1, 3, 6, 8, 10]);

function countBlackKeys(rootIdx, scaleKey) {
  return SCALES[scaleKey].intervals.filter(iv => BLACK_KEY_INDICES.has((rootIdx + iv) % 12)).length;
}

function getSortedRoots(scaleKey) {
  return NOTE_DISPLAY.slice().sort((a, b) => {
    const idxA = NOTE_DISPLAY.indexOf(a);
    const idxB = NOTE_DISPLAY.indexOf(b);
    const diff = countBlackKeys(idxA, scaleKey) - countBlackKeys(idxB, scaleKey);
    return diff !== 0 ? diff : idxA - idxB;
  });
}

function getChords(rootIdx, scaleKey, chordType) {
  const scale = SCALES[scaleKey];
  const seventhList = scaleKey==="major" ? SEVENTHS_MAJOR : scaleKey==="minor" ? SEVENTHS_MINOR : SEVENTHS_OTHER;
  const ninthList   = scaleKey==="major" ? NINTHS_MAJOR   : scaleKey==="minor" ? NINTHS_MINOR   : NINTHS_OTHER;
  return scale.intervals.map((interval, i) => {
    const noteIdx = (rootIdx + interval) % 12;
    const quality = chordType==="9" ? ninthList[i] : chordType==="7" ? seventhList[i] : scale.qualities[i];
    const suffix = quality==="maj"?"": quality==="min"?"m": quality==="dim"?"°":
                   quality==="maj7"?"maj7": quality==="m7"?"m7": quality==="7"?"7":
                   quality==="m7b5"?"m7b5": quality==="maj9"?"maj9":
                   quality==="m9"?"m9": quality==="9"?"9": quality;
    return { noteIdx, quality, degree:scale.degrees[i], display:NOTES[noteIdx]+suffix };
  });
}

function getChordNoteIndices(noteIdx, quality) {
  return (CHORD_INTERVALS[quality] || CHORD_INTERVALS["maj"]).map(i => (noteIdx+i)%12);
}

function getChordNoteNames(noteIdx, quality, baseOctave=4) {
  const intervals = CHORD_INTERVALS[quality] || CHORD_INTERVALS["maj"];
  let octave = baseOctave;
  let prev = -1;
  return intervals.map(i => {
    const ni = (noteIdx + i) % 12;
    if (ni < prev) octave++; // wrap to next octave
    prev = ni;
    return NOTES[ni] + octave;
  });
}

function getStepPattern(intervals) {
  return intervals.map((iv, i) => {
    const next = i < intervals.length-1 ? intervals[i+1] : 12;
    const diff = next - iv;
    return diff === 2 ? "W" : diff === 1 ? "H" : diff === 3 ? "A" : String(diff);
  });
}

// Tiny strum + jitter offsets — bass notes hit first, slight random variation
// Arp humanizer — swing timing + ±25% velocity for each step
function arpHumanize(i, rateSec) {
  // Micro-timing jitter ±3% of a step — just enough to feel human, no swing
  const swing  = 0;
  const jitter = (Math.random() - 0.5) * rateSec * 0.06;
  // Velocity: base 0.78, ±25% (clamped 0.3–1.0)
  const vel    = Math.min(1, Math.max(0.3, 0.78 + (Math.random() - 0.5) * 0.5));
  return { offsetSec: swing + jitter, vel };
}

// Arp pattern helper — returns notes in chosen order
function getArpNotes(noteNames, pattern) {
  const sorted = [...noteNames].sort((a, b) => nameToMidi(a) - nameToMidi(b));
  if (pattern === "down")   return sorted.slice().reverse();
  if (pattern === "updown") return sorted.length <= 2 ? sorted : [...sorted, ...sorted.slice(1, -1).reverse()];
  if (pattern === "random") return sorted.slice().sort(() => Math.random() - 0.5);
  return sorted; // "up"
}

function strumOffsets(count) {
  return Array.from({ length: count }, (_, i) => i * 0.013 + Math.random() * 0.007);
}

// Human-feel velocity curve: bass notes louder, inner voices softer, slight random swing
function humanVelocities(count) {
  return Array.from({ length: count }, (_, i) => {
    // Bass note (i=0) gets boost; top note (i=count-1) gets slight lift; inner voices dip
    const base = i === 0 ? 0.88 : i === count - 1 ? 0.76 : 0.62;
    return base + (Math.random() * 0.14 - 0.07); // ±7 %
  });
}

async function playChord(noteNames, soundType="piano") {
  await Tone.start();
  const s = getInstrument(soundType);
  if (soundType === "piano") await Tone.loaded();
  const now = Tone.now();
  const offsets = strumOffsets(noteNames.length);
  const vels    = humanVelocities(noteNames.length);
  noteNames.forEach((note, i) => {
    // Tone.js Sampler doesn't expose per-note velocity via triggerAttackRelease,
    // but we can scale note duration slightly per velocity to mimic touch weight
    const durScale = 0.85 + vels[i] * 0.3;
    s.triggerAttackRelease(note, `${durScale}n`, now + offsets[i], vels[i]);
  });
}

async function playSingleNote(noteName, soundType="piano") {
  await Tone.start();
  const s = getInstrument(soundType);
  if (soundType === "piano") await Tone.loaded();
  s.triggerAttackRelease(noteName, "4n");
}

async function playScale(noteIndices, soundType="piano") {
  await Tone.start();
  const s = getInstrument(soundType);
  if (soundType === "piano") await Tone.loaded();
  const now = Tone.now();

  let octave = 4;
  const notes = noteIndices.map((ni, i) => {
    if (i > 0 && ni < noteIndices[i - 1]) octave++;
    return { note: NOTES[ni] + octave, time: now + i * 0.32 };
  });
  notes.push({ note: NOTES[noteIndices[0]] + "5", time: now + noteIndices.length * 0.32 });

  notes.forEach(({ note, time }) => s.triggerAttackRelease(note, "8n", time));
}

// ─── Chord text parser ────────────────────────────────────────────────────────

const FLAT_TO_SHARP = { Db:"C#", Eb:"D#", Gb:"F#", Ab:"G#", Bb:"A#" };
const QUALITY_MAP = {
  // major triad
  "":"maj", "maj":"maj", "major":"maj", "M":"maj",
  // minor
  "m":"min", "min":"min", "minor":"min",
  // diminished / augmented
  "dim":"dim", "°":"dim",
  "aug":"aug", "+":"aug",
  // suspended
  "sus2":"sus2", "sus4":"sus4", "sus":"sus4",
  // 6ths
  "6":"6", "maj6":"6",
  "m6":"m6", "min6":"m6",
  // 7ths
  "maj7":"maj7", "major7":"maj7", "Δ":"maj7", "Δ7":"maj7", "M7":"maj7",
  "m7":"m7", "min7":"m7", "-7":"m7",
  "7":"7", "dom7":"7", "dom":"7",
  "m7b5":"m7b5", "ø":"m7b5", "ø7":"m7b5", "min7b5":"m7b5",
  "dim7":"dim7", "°7":"dim7",
  "aug7":"aug7", "7#5":"aug7", "+7":"aug7",
  "7sus4":"7sus4",
  // 9ths
  "maj9":"maj9", "major9":"maj9", "M9":"maj9",
  "m9":"m9", "min9":"m9",
  "9":"9",
  "add9":"add9", "add2":"add9",
  "madd9":"madd9", "madd2":"madd9",
  "7b9":"7b9",
  "7#9":"7#9",
  // 11ths
  "11":"11", "maj11":"maj11", "m11":"m11",
  // 13ths
  "13":"13", "maj13":"maj13", "m13":"m13",
};
const QUALITY_DISPLAY = {
  maj:"", min:"m", dim:"°", aug:"aug",
  sus2:"sus2", sus4:"sus4",
  "6":"6", m6:"m6",
  maj7:"maj7", m7:"m7", "7":"7", m7b5:"m7b5",
  dim7:"dim7", aug7:"aug7", "7sus4":"7sus4",
  maj9:"maj9", m9:"m9", "9":"9",
  add9:"add9", madd9:"madd9",
  "7b9":"7b9", "7#9":"7#9",
  "11":"11", maj11:"maj11", m11:"m11",
  "13":"13", maj13:"maj13", m13:"m13",
};

function parseChordText(input) {
  const str = input.trim();
  if (!str) return null;
  const m = str.match(/^([A-Ga-g][#b]?)(.*)/);
  if (!m) return null;
  let root = m[1][0].toUpperCase() + (m[1][1] || "").replace("b","b");
  // normalize flat notation
  if (root.endsWith("b") && FLAT_TO_SHARP[root]) root = FLAT_TO_SHARP[root];
  const noteIdx = NOTES.indexOf(root);
  if (noteIdx === -1) return null;
  const qualStr = m[2].trim();
  const quality = QUALITY_MAP[qualStr];
  if (quality === undefined) return null;
  return { noteIdx, quality, degree:"", display: NOTES[noteIdx] + QUALITY_DISPLAY[quality] };
}

// ─── MIDI helpers ────────────────────────────────────────────────────────────

const NOTE_TO_SEMITONE = { C:0,"C#":1,D:2,"D#":3,E:4,F:5,"F#":6,G:7,"G#":8,A:9,"A#":10,B:11 };

function nameToMidi(noteName) {
  const m = noteName.match(/^([A-G]#?)(\d)$/);
  if (!m) return 60;
  return (parseInt(m[2]) + 1) * 12 + NOTE_TO_SEMITONE[m[1]];
}

// ─── Piano ───────────────────────────────────────────────────────────────────

const WHITE_IN_OCT  = [0,2,4,5,7,9,11];
const BLACK_IN_OCT  = [1,3,6,8,10];
const BLACK_OFFSETS = [0.60,1.65,3.60,4.55,5.50];
const WHITE_NAMES   = ["C","D","E","F","G","A","B"];
const BLACK_NAMES   = ["C#","D#","F#","G#","A#"];

function Piano({ highlightedNotes=[], scaleNoteIndices=[], highlightAllOctaves=false, t, onNoteClick }) {
  const WK = 14, wkw = 100/WK;
  const whiteKeys = [], blackKeys = [];
  for (let oct=0; oct<2; oct++) {
    WHITE_IN_OCT.forEach((ni,wi) =>
      whiteKeys.push({ noteIdx:ni, pos:oct*7+wi, octave:oct+4, name:WHITE_NAMES[wi] }));
    BLACK_IN_OCT.forEach((ni,bi) =>
      blackKeys.push({ noteIdx:ni, leftPct:(BLACK_OFFSETS[bi]+oct*7)*wkw, octave:oct+4, name:BLACK_NAMES[bi] }));
  }

  const [hoveredKey, setHoveredKey] = useState(null);

  return (
    <div style={{ position:"relative", width:"100%", height:150, userSelect:"none" }}>
      {whiteKeys.map((k,i) => {
        const hl = highlightedNotes.includes(k.noteIdx) && (highlightAllOctaves || k.octave===4);
        const sc = !highlightAllOctaves && scaleNoteIndices.includes(k.noteIdx);
        const hovered = hoveredKey === `w${i}`;
        const isActive = hl || sc;
        return (
          <div key={i}
            onClick={() => onNoteClick?.(k.name+k.octave)}
            onMouseEnter={() => setHoveredKey(`w${i}`)}
            onMouseLeave={() => setHoveredKey(null)}
            style={{
              position:"absolute", left:`calc(${k.pos*wkw}% + 1px)`, width:`calc(${wkw}% - 2px)`,
              height:"100%",
              background: hl
                ? "#5C7C8A"
                : sc
                  ? "rgba(92,124,138,0.12)"
                  : hovered
                    ? "#F8F7FA"
                    : "#FFFFFF",
              border: hl
                ? "1px solid rgba(92,124,138,0.5)"
                : sc
                  ? "1px solid rgba(92,124,138,0.25)"
                  : `1px solid ${t.whiteKeyBorder}`,
              borderTop:"none",
              borderRadius:"0 0 1px 1px", cursor:"pointer",
              transition:"all 0.08s",
              display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"flex-end",
              paddingBottom:10, boxSizing:"border-box",
            }}>
            {/* Note dot for scale/highlighted */}
            {isActive && (
              <div style={{
                width: 6, height: 6, borderRadius: "50%",
                background: hl ? "#fff" : t.accent,
                opacity: hl ? 0.9 : 0.5,
                marginBottom: 5,
                boxShadow: "none",
              }} />
            )}
            <span style={{
              fontSize: 9.5,
              fontFamily: SF,
              fontWeight: hl ? 700 : isActive ? 550 : 420,
              color: hl ? "#fff" : sc ? t.accent : "rgba(0,0,0,0.50)",
              letterSpacing: "0.02em",
              lineHeight: 1,
            }}>
              {k.name}{k.noteIdx === 0 ? k.octave : ""}
            </span>
          </div>
        );
      })}
      {blackKeys.map((k,i) => {
        const hl = highlightedNotes.includes(k.noteIdx) && (highlightAllOctaves || k.octave===4);
        const sc = !highlightAllOctaves && scaleNoteIndices.includes(k.noteIdx);
        const hovered = hoveredKey === `b${i}`;
        return (
          <div key={i}
            onClick={e => { e.stopPropagation(); onNoteClick?.(k.name+k.octave); }}
            onMouseEnter={() => setHoveredKey(`b${i}`)}
            onMouseLeave={() => setHoveredKey(null)}
            style={{
              position:"absolute", left:`${k.leftPct}%`, width:`${wkw*0.58}%`, height:"62%",
              background: hl
                ? "#4A6878"
                : sc
                  ? "#526E7C"
                  : hovered
                    ? "#302A38"
                    : "#2A2A2A",
              borderRadius:"0 0 1px 1px", zIndex:2, cursor:"pointer",
              transition:"all 0.08s",
              display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"flex-end",
              paddingBottom:6,
              transform: hovered ? "scaleY(0.97)" : "none",
              transformOrigin: "top",
            }}>
            {(hl || sc) && (
              <div style={{
                width: 5, height: 5, borderRadius: "50%",
                background: "#fff",
                opacity: hl ? 0.9 : 0.4,
                marginBottom: 4,
                boxShadow: "none",
              }} />
            )}
            <span style={{
              fontSize: 7.5,
              fontFamily: SF,
              fontWeight: hl ? 700 : sc ? 600 : 450,
              color: hl ? "rgba(255,255,255,0.95)" : sc ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.32)",
              letterSpacing: "0.01em",
              lineHeight: 1,
            }}>
              {k.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Segmented Control ────────────────────────────────────────────────────────

function SegmentedControl({ value, options, onChange, t }) {
  return (
    <div style={{ display:"inline-flex", background:t.segBg, borderRadius:2, padding:2, gap:2 }}>
      {options.map(opt => (
        <button key={opt.value} onClick={() => onChange(opt.value)} style={{
          padding:"5px 14px", borderRadius:2, border:"none",
          background: value===opt.value ? t.segActiveBg : "transparent",
          boxShadow:  value===opt.value ? t.segShadow : "none",
          fontFamily:SF, fontSize:13,
          fontWeight: value===opt.value ? 510 : 400,
          color: value===opt.value ? t.segActiveColor : t.segInactiveColor,
          cursor:"pointer", transition:"all 0.08s", whiteSpace:"nowrap",
        }}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ─── Key Detector ─────────────────────────────────────────────────────────────

const MAJOR_PROFILE = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const MINOR_PROFILE = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
const NOTE_NAMES    = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s,x)=>s+x,0)/n;
  const mb = b.reduce((s,x)=>s+x,0)/n;
  let num=0, da=0, db=0;
  for (let i=0;i<n;i++) { num+=(a[i]-ma)*(b[i]-mb); da+=(a[i]-ma)**2; db+=(b[i]-mb)**2; }
  return da && db ? num/Math.sqrt(da*db) : 0;
}

// Autocorrelation-based pitch detector (no external deps)
function detectPitchAutocorr(buf, sampleRate) {
  const SIZE = buf.length;
  // Check if signal is loud enough
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  if (Math.sqrt(rms / SIZE) < 0.01) return null;

  // Autocorrelation
  const corr = new Float32Array(SIZE);
  for (let lag = 0; lag < SIZE; lag++) {
    let sum = 0;
    for (let i = 0; i < SIZE - lag; i++) sum += buf[i] * buf[i + lag];
    corr[lag] = sum;
  }

  // Find first dip then first peak after it (fundamental period)
  let d = 0;
  while (d < SIZE && corr[d] > corr[d + 1]) d++;
  let maxVal = -1, maxLag = -1;
  for (let i = d; i < SIZE; i++) {
    if (corr[i] > maxVal) { maxVal = corr[i]; maxLag = i; }
  }
  if (maxLag === -1 || maxVal / corr[0] < 0.5) return null;
  return sampleRate / maxLag;
}

function matchKey(chroma) {
  let best = { score:-Infinity, tonic:"C", type:"major" };
  for (let r=0; r<12; r++) {
    const rot = [...chroma.slice(r), ...chroma.slice(0,r)];
    const maj = pearson(rot, MAJOR_PROFILE);
    const min = pearson(rot, MINOR_PROFILE);
    if (maj > best.score) best = { score:maj, tonic:NOTE_NAMES[r], type:"major" };
    if (min > best.score) best = { score:min, tonic:NOTE_NAMES[r], type:"minor" };
  }
  return best;
}

function KeyDetector({ t }) {
  const [detectMode,     setDetectMode]     = useState("mic"); // "mic" | "file"

  // ── Mic state ──────────────────────────────────────────────────────
  const [listening,      setListening]      = useState(false);
  const [micResult,      setMicResult]      = useState(null);
  const [micChroma,      setMicChroma]      = useState(new Array(12).fill(0));
  const [micError,       setMicError]       = useState(null);
  const audioCtxRef  = useRef(null);
  const analyserRef  = useRef(null);
  const streamRef    = useRef(null);
  const rafRef       = useRef(null);
  const chromaAccRef = useRef(new Array(12).fill(0));

  // ── Record & analyse state ─────────────────────────────────────────
  const [isRecording,    setIsRecording]    = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);
  const [fileAnalyzing,  setFileAnalyzing]  = useState(false);
  const [fileProgress,   setFileProgress]   = useState(0);
  const [fileResult,     setFileResult]     = useState(null);
  const [fileCandidates, setFileCandidates] = useState([]);
  const [fileChroma,     setFileChroma]     = useState(new Array(12).fill(0));
  const [fileError,      setFileError]      = useState(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef        = useRef([]);
  const recordTimerRef   = useRef(null);
  const abortRef         = useRef(false);

  // ── Mic callbacks ──────────────────────────────────────────────────
  const stopListening = useCallback(() => {
    if (rafRef.current)    cancelAnimationFrame(rafRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(tr => tr.stop());
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") audioCtxRef.current.close();
    setListening(false);
  }, []);

  const startListening = useCallback(async () => {
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      streamRef.current = stream; audioCtxRef.current = audioCtx; analyserRef.current = analyser;
      chromaAccRef.current = new Array(12).fill(0);
      setListening(true);
      const buf = new Float32Array(analyser.fftSize);
      const sampleRate = audioCtx.sampleRate;
      const loop = () => {
        analyser.getFloatTimeDomainData(buf);
        const pitch = detectPitchAutocorr(buf, sampleRate);
        if (pitch && pitch > 50 && pitch < 2500) {
          const midi = Math.round(12 * Math.log2(pitch / 440) + 69);
          const pc   = ((midi % 12) + 12) % 12;
          chromaAccRef.current = chromaAccRef.current.map((v,i) => v * 0.992 + (i===pc ? 0.12 : 0));
        } else {
          chromaAccRef.current = chromaAccRef.current.map(v => v * 0.992);
        }
        const snap = [...chromaAccRef.current];
        setMicChroma(snap);
        if (snap.reduce((s,x)=>s+x,0) > 0.4) setMicResult(matchKey(snap));
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    } catch { setMicError("Microphone access denied. Please allow microphone permissions and try again."); }
  }, []);

  const resetMic = useCallback(() => {
    chromaAccRef.current = new Array(12).fill(0);
    setMicChroma(new Array(12).fill(0));
    setMicResult(null);
  }, []);

  // ── Record & analyse ───────────────────────────────────────────────
  const analyzeBlob = useCallback(async (blob) => {
    abortRef.current = false;
    setFileAnalyzing(true);
    setFileProgress(0);
    setFileResult(null);
    setFileCandidates([]);
    setFileChroma(new Array(12).fill(0));
    setFileError(null);

    try {
      const arrayBuf  = await blob.arrayBuffer();
      const audioCtx  = new AudioContext();
      const decoded   = await audioCtx.decodeAudioData(arrayBuf);
      await audioCtx.close();

      const sr = decoded.sampleRate;
      // Mix to mono
      let mono;
      if (decoded.numberOfChannels === 1) {
        mono = decoded.getChannelData(0);
      } else {
        const c0 = decoded.getChannelData(0), c1 = decoded.getChannelData(1);
        mono = new Float32Array(c0.length);
        for (let i = 0; i < c0.length; i++) mono[i] = (c0[i] + c1[i]) * 0.5;
      }

      const WIN     = 2048;
      const HOP     = Math.round(sr * 0.4);         // 400 ms hop
      const minLag  = Math.floor(sr / 2500);         // highest pitch we care about
      const maxLag  = Math.ceil(sr / 50);            // lowest pitch (50 Hz)
      const total   = Math.floor((mono.length - WIN) / HOP);
      const chroma  = new Array(12).fill(0);
      let hop = 0;

      await new Promise((resolve, reject) => {
        const step = () => {
          if (abortRef.current) { reject(new Error("cancelled")); return; }
          // 4 hops per frame keeps the UI responsive
          for (let b = 0; b < 4 && hop < total; b++, hop++) {
            const win = mono.subarray(hop * HOP, hop * HOP + WIN);
            // RMS gate — skip silence
            let rms = 0;
            for (let i = 0; i < WIN; i++) rms += win[i] * win[i];
            if (Math.sqrt(rms / WIN) < 0.01) continue;
            // Autocorrelation over musical pitch range only (much faster than full range)
            const corr = new Float32Array(maxLag + 1);
            for (let lag = minLag; lag <= maxLag; lag++) {
              let s = 0;
              for (let i = 0; i < WIN - lag; i++) s += win[i] * win[i + lag];
              corr[lag] = s;
            }
            let d = minLag;
            while (d < maxLag && corr[d] > corr[d+1]) d++;
            let bestVal = -1, bestLag = -1;
            for (let i = d; i <= maxLag; i++) {
              if (corr[i] > bestVal) { bestVal = corr[i]; bestLag = i; }
            }
            if (bestLag > 0 && bestVal / (corr[minLag] || 1) > 0.25) {
              const pc = ((Math.round(12 * Math.log2((sr / bestLag) / 440) + 69)) % 12 + 12) % 12;
              chroma[pc]++;
            }
          }
          setFileProgress(Math.round(hop / total * 100));
          hop < total ? setTimeout(step, 0) : resolve();
        };
        step();
      });

      // Normalise chroma to roughly unit scale
      const sum  = chroma.reduce((a,x) => a+x, 0);
      const norm = sum > 0 ? chroma.map(x => (x / sum) * 12) : chroma;
      setFileChroma(norm);

      // Rank all 24 keys
      const cands = [];
      for (let r = 0; r < 12; r++) {
        const rot = [...norm.slice(r), ...norm.slice(0, r)];
        cands.push({ score: pearson(rot, MAJOR_PROFILE), tonic: NOTE_NAMES[r], type: "major" });
        cands.push({ score: pearson(rot, MINOR_PROFILE), tonic: NOTE_NAMES[r], type: "minor" });
      }
      cands.sort((a, b) => b.score - a.score);
      setFileResult(cands[0]);
      setFileCandidates(cands.slice(0, 5));
    } catch (err) {
      if (err.message !== "cancelled") setFileError("Could not analyse the recording. Please try again.");
    } finally {
      setFileAnalyzing(false);
    }
  }, []);

  const startRecording = useCallback(async () => {
    setFileError(null);
    setFileResult(null);
    setFileCandidates([]);
    setFileChroma(new Array(12).fill(0));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      // Pick a widely-supported MIME type
      const mimeType = ["audio/webm;codecs=opus","audio/webm","audio/ogg","audio/mp4"]
        .find(m => MediaRecorder.isTypeSupported(m)) || "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        analyzeBlob(blob);
      };
      recorder.start(100); // collect chunks every 100 ms
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      setRecordDuration(0);
      recordTimerRef.current = setInterval(() => setRecordDuration(d => d + 1), 1000);
    } catch {
      setFileError("Microphone access denied. Please allow microphone permissions.");
    }
  }, [analyzeBlob]);

  const stopRecording = useCallback(() => {
    clearInterval(recordTimerRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  useEffect(() => () => {
    stopListening();
    stopRecording();
    abortRef.current = true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const SF2   = SF;
  const card2 = { background:t.cardBg, border:`1px solid ${t.border}`, padding:"12px 14px", marginBottom:1 };
  const lbl   = { fontSize:11, display:"block", marginBottom:6, color:t.labelColor, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.07em", fontFamily:SF2 };

  const result     = detectMode === "file" ? fileResult  : micResult;
  const chroma     = detectMode === "file" ? fileChroma  : micChroma;
  const maxChroma  = Math.max(...chroma, 0.01);
  const confidence = result ? Math.round(((result.score + 1) / 2) * 100) : 0;

  return (
    <>
      {/* Mode switcher */}
      <div style={card2}>
        <div style={{ display:"flex", gap:6 }}>
          {[{key:"mic", label:"🎤 Microphone"}, {key:"file", label:"⏺ Record & Analyse"}].map(({ key, label }) => (
            <button key={key} onClick={() => setDetectMode(key)} style={{
              fontFamily:SF2, fontSize:13, fontWeight: detectMode===key ? 600 : 400,
              padding:"8px 20px", borderRadius:2,
              background: detectMode===key ? t.accent    : t.elevatedBg,
              border:     `1px solid ${detectMode===key ? t.accent : t.border}`,
              color:      detectMode===key ? "#FFFFFF"   : t.textSecondary,
              cursor:"pointer", transition:"all 0.08s",
            }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Microphone controls ── */}
      {detectMode === "mic" && (
        <div style={card2}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:12 }}>
            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
              <div style={{
                width:10, height:10, borderRadius:"50%", flexShrink:0,
                background: listening ? "#30D158" : t.textTertiary,
                boxShadow:  listening ? "0 0 0 3px rgba(48,209,88,0.25)" : "none",
                transition:"all 0.3s ease",
              }} />
              <div>
                <div style={{ fontSize:14, fontWeight:600, color:t.textPrimary, fontFamily:SF2 }}>
                  {listening ? "Listening…" : "Microphone off"}
                </div>
                <div style={{ fontSize:12, color:t.textSecondary, marginTop:2 }}>
                  {listening ? "Play or sing notes — the key detector will analyse in real time"
                             : "Start the microphone to detect the key from audio"}
                </div>
              </div>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={listening ? stopListening : startListening} style={{
                fontFamily:SF2, fontSize:13, fontWeight:600, padding:"8px 22px", borderRadius:2, border:"none",
                background: listening ? "#FF453A" : t.accent, color:"#FFFFFF", cursor:"pointer", transition:"background 0.15s",
              }}>
                {listening ? "⬛ Stop" : "🎤 Start"}
              </button>
              <button onClick={resetMic} style={{
                fontFamily:SF2, fontSize:13, fontWeight:500, padding:"8px 16px", borderRadius:2,
                border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer",
              }}>Reset</button>
            </div>
          </div>
          {micError && (
            <div style={{ marginTop:12, padding:"10px 14px", borderRadius:2,
              background:"rgba(255,69,58,0.12)", border:"1px solid rgba(255,69,58,0.3)",
              fontSize:13, color:"#FF453A", fontFamily:SF2 }}>
              {micError}
            </div>
          )}
        </div>
      )}

      {/* ── Record & Analyse controls ── */}
      {detectMode === "file" && (
        <div style={card2}>
          {/* Record button / recording state */}
          {!fileAnalyzing && (
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:20, padding:"16px 0" }}>
              {isRecording ? (
                <>
                  {/* Pulsing indicator + duration */}
                  <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                    <div style={{
                      width:14, height:14, borderRadius:"50%", background:"#FF453A",
                      boxShadow:"0 0 0 4px rgba(255,69,58,0.25)",
                      animation:"pulse 1.2s ease-in-out infinite", flexShrink:0,
                    }} />
                    <span style={{ fontSize:22, fontWeight:700, fontFamily:SF2, color:t.textPrimary, letterSpacing:"0.03em" }}>
                      {`${Math.floor(recordDuration/60).toString().padStart(2,"0")}:${(recordDuration%60).toString().padStart(2,"0")}`}
                    </span>
                  </div>
                  <div style={{ fontSize:13, color:t.textSecondary, fontFamily:SF2 }}>
                    Recording… play or sing something, then press Stop
                  </div>
                  <button onClick={stopRecording} style={{
                    fontFamily:SF2, fontSize:15, fontWeight:700, padding:"13px 44px",
                    borderRadius:2, border:"none", background:"#FF453A",
                    color:"#FFFFFF", cursor:"pointer", transition:"background 0.15s",
                  }}>
                    ⬛ Stop
                  </button>
                </>
              ) : (
                <>
                  <div style={{ fontSize:13, color:t.textSecondary, fontFamily:SF2, textAlign:"center" }}>
                    {fileResult
                      ? "Press record to run a new analysis"
                      : "Press record, play or sing your sample, then stop — the recording will be analysed for its root key"}
                  </div>
                  <button onClick={startRecording} style={{
                    fontFamily:SF2, fontSize:15, fontWeight:700, padding:"13px 44px",
                    borderRadius:2, border:"none", background:t.accent,
                    color:"#FFFFFF", cursor:"pointer", transition:"background 0.15s",
                  }}>
                    ⏺ Start recording
                  </button>
                </>
              )}
            </div>
          )}

          {/* Analysis progress */}
          {fileAnalyzing && (
            <div>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                <span style={{ fontSize:13, fontWeight:600, color:t.textPrimary, fontFamily:SF2 }}>
                  Analysing recording…
                </span>
                <span style={{ fontSize:13, fontWeight:700, color:t.accent, fontFamily:SF2 }}>{fileProgress}%</span>
              </div>
              <div style={{ height:6, borderRadius:1, background:t.elevatedBg, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${fileProgress}%`, borderRadius:1,
                  background:t.accent, transition:"width 0.2s ease" }} />
              </div>
              <button onClick={() => { abortRef.current = true; setFileAnalyzing(false); }}
                style={{ marginTop:12, fontFamily:SF2, fontSize:12, fontWeight:500, padding:"6px 14px",
                  borderRadius:2, border:`1px solid ${t.btnBorder}`, background:t.btnBg,
                  color:t.btnColor, cursor:"pointer" }}>
                Cancel
              </button>
            </div>
          )}

          {fileError && !fileAnalyzing && !isRecording && (
            <div style={{ marginTop:10, padding:"10px 14px", borderRadius:2,
              background:"rgba(255,69,58,0.10)", border:"1px solid rgba(255,69,58,0.28)",
              fontSize:13, color:"#FF453A", fontFamily:SF2 }}>
              {fileError}
            </div>
          )}
        </div>
      )}

      {/* ── Result hero (shared) ── */}
      <div style={{ ...card2, textAlign:"center", padding:"32px 24px" }}>
        {result ? (
          <>
            <div style={{ fontSize:11, color:t.textSecondary, fontWeight:600, fontFamily:SF2, marginBottom:14,
              textTransform:"uppercase", letterSpacing:"0.12em" }}>
              Detected Key
            </div>
            <div style={{ fontSize:72, fontWeight:800, letterSpacing:"-0.04em", color:t.accent, fontFamily:SF2, lineHeight:1 }}>
              {result.tonic}
            </div>
            <div style={{ fontSize:26, fontWeight:500, color:t.textPrimary, fontFamily:SF2, marginTop:6, marginBottom:22 }}>
              {result.type === "major" ? "Major" : "Minor"}
            </div>
            <div style={{ maxWidth:280, margin:"0 auto" }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                <span style={{ fontSize:11, color:t.labelColor, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.07em" }}>Confidence</span>
                <span style={{ fontSize:11, color:t.accent, fontWeight:700 }}>{confidence}%</span>
              </div>
              <div style={{ height:6, borderRadius:1, background:t.elevatedBg, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${confidence}%`, borderRadius:1,
                  background:t.accent, transition:"width 0.3s ease" }} />
              </div>
            </div>
            {/* Runner-up candidates — only in file mode */}
            {detectMode === "file" && fileCandidates.length > 1 && (
              <div style={{ marginTop:20 }}>
                <div style={{ fontSize:11, color:t.labelColor, fontWeight:600, textTransform:"uppercase",
                  letterSpacing:"0.07em", marginBottom:10 }}>
                  Other candidates
                </div>
                <div style={{ display:"flex", gap:8, justifyContent:"center", flexWrap:"wrap" }}>
                  {fileCandidates.slice(1).map((c, i) => (
                    <div key={i} style={{
                      padding:"5px 14px", borderRadius:2,
                      background:t.elevatedBg, border:`1px solid ${t.border}`,
                      fontSize:13, fontWeight:600, color:t.textSecondary, fontFamily:SF2,
                    }}>
                      {c.tonic} {c.type === "major" ? "maj" : "min"}
                      <span style={{ fontSize:11, fontWeight:400, color:t.textTertiary, marginLeft:5 }}>
                        {Math.round(((c.score+1)/2)*100)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div style={{ color:t.textTertiary, fontSize:16, fontFamily:SF2, padding:"16px 0" }}>
            {detectMode === "mic"
              ? (listening ? "Gathering audio…" : "Start the microphone to detect a key")
              : (fileAnalyzing ? "Analysing recording…" : "Record something above to detect its key")}
          </div>
        )}
      </div>

      {/* ── Chroma bars ── */}
      <div style={card2}>
        <div style={lbl}>Chroma vector — pitch class energy</div>
        <div style={{ display:"flex", alignItems:"flex-end", gap:4, height:100, marginTop:8 }}>
          {NOTE_NAMES.map((name, i) => {
            const pct = chroma[i] / maxChroma;
            const isResult = result && result.tonic === name;
            return (
              <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:4, height:"100%" }}>
                <div style={{ flex:1, width:"100%", display:"flex", alignItems:"flex-end" }}>
                  <div style={{
                    width:"100%", height:`${Math.max(pct*100,2)}%`, borderRadius:"1px 1px 0 0",
                    background: isResult ? t.accent : pct > 0.4 ? t.accentBg : t.elevatedBg,
                    border: isResult ? `1px solid ${t.accent}` : `1px solid ${t.border}`,
                    transition:"height 0.15s ease, background 0.2s ease",
                  }} />
                </div>
                <span style={{ fontSize:9, fontWeight: isResult ? 700 : 400,
                  color: isResult ? t.accent : t.textTertiary, fontFamily:SF2, lineHeight:1 }}>
                  {name}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── How it works ── */}
      <div style={{ ...card2, background:t.elevatedBg }}>
        <div style={lbl}>How it works</div>
        <p style={{ fontSize:13, color:t.textSecondary, margin:0, lineHeight:1.6, fontFamily:SF2 }}>
          {detectMode === "mic" ? <>
            The detector listens through your microphone and uses{" "}
            <strong style={{ color:t.textPrimary }}>autocorrelation</strong> to detect pitch in real time.
            Detected notes build up a <strong style={{ color:t.textPrimary }}>chroma vector</strong> that decays slowly over time.
            The key is matched using <strong style={{ color:t.textPrimary }}>Krumhansl–Schmuckler profiles</strong>.
          </> : <>
            Press <strong style={{ color:t.textPrimary }}>Start recording</strong>, play or sing the sample, then press{" "}
            <strong style={{ color:t.textPrimary }}>Stop</strong>. The recording is scanned in 400 ms windows using{" "}
            <strong style={{ color:t.textPrimary }}>autocorrelation pitch detection</strong>. Detected pitch classes
            accumulate into a <strong style={{ color:t.textPrimary }}>chroma vector</strong> matched against all 24
            major/minor keys using <strong style={{ color:t.textPrimary }}>Krumhansl–Schmuckler profiles</strong>.
            Longer recordings give more accurate results.
          </>}
        </p>
      </div>
    </>
  );
}

// ─── MusicXML Parser ─────────────────────────────────────────────────────────

function xmlNoteNameFromEl(noteEl) {
  const step   = noteEl.querySelector("pitch > step")?.textContent   || "C";
  const octave = noteEl.querySelector("pitch > octave")?.textContent || "4";
  const alter  = parseFloat(noteEl.querySelector("pitch > alter")?.textContent || "0");
  const FLAT_MAP = { D:"C#", E:"D#", G:"F#", A:"G#", B:"A#", C:"B", F:"E" };
  if (alter >= 0.5)  return step + "#" + octave;
  if (alter <= -0.5) return (FLAT_MAP[step] || step) + octave;
  return step + octave;
}

function parseMusicXML(xmlStr) {
  const doc = new DOMParser().parseFromString(xmlStr, "text/xml");
  if (doc.querySelector("parseerror,parsererror")) return null;

  const title =
    doc.querySelector("movement-title")?.textContent?.trim() ||
    doc.querySelector("work-title")?.textContent?.trim() ||
    "Untitled";

  let globalTempo = 120;
  const allEvents = [];

  // Process every <part> (e.g. right hand + left hand as separate parts,
  // or a single part with <backup> elements for multi-voice staves)
  for (const part of doc.querySelectorAll("part")) {
    let tempo       = globalTempo;
    let divisions   = 1;
    let timeSec     = 0;
    const partEvts  = [];

    for (const measure of part.querySelectorAll("measure")) {
      // Iterate direct children in document order so <backup>/<forward> are respected
      for (const child of measure.children) {
        const tag = child.tagName.toLowerCase();

        if (tag === "attributes") {
          const divEl = child.querySelector("divisions");
          if (divEl) divisions = parseInt(divEl.textContent) || 1;

        } else if (tag === "direction") {
          const soundEl = child.querySelector("sound[tempo]");
          if (soundEl) { tempo = parseFloat(soundEl.getAttribute("tempo")) || tempo; globalTempo = tempo; }

        } else if (tag === "sound" && child.getAttribute("tempo")) {
          tempo = parseFloat(child.getAttribute("tempo")) || tempo; globalTempo = tempo;

        } else if (tag === "backup") {
          // Rewind time (second voice / left hand in same part)
          const d = parseInt(child.querySelector("duration")?.textContent || "0");
          timeSec -= (d / divisions) * (60 / tempo);
          if (timeSec < 0) timeSec = 0;

        } else if (tag === "forward") {
          const d = parseInt(child.querySelector("duration")?.textContent || "0");
          timeSec += (d / divisions) * (60 / tempo);

        } else if (tag === "note") {
          const isChord = !!child.querySelector("chord");
          const isRest  = !!child.querySelector("rest");
          const durDivs = parseInt(child.querySelector("duration")?.textContent || "0");
          const durSec  = (durDivs / divisions) * (60 / tempo);

          if (isChord) {
            // Same onset as previous note — attach to its event
            if (!isRest && partEvts.length > 0) {
              partEvts[partEvts.length - 1].notes.push(xmlNoteNameFromEl(child));
            }
            // chord notes don't advance time
          } else {
            if (!isRest) {
              partEvts.push({ time: timeSec, duration: durSec, notes: [xmlNoteNameFromEl(child)] });
            }
            timeSec += durSec;
          }
        }
      }
    }
    allEvents.push(...partEvts);
  }

  // Sort all events (both hands) by onset time
  allEvents.sort((a, b) => a.time !== b.time ? a.time - b.time : 0);

  const duration = allEvents.length > 0
    ? Math.max(...allEvents.map(e => e.time + e.duration))
    : 0;

  return { title, tempo: Math.round(globalTempo), events: allEvents, duration };
}

// ─── Sheet Music Tab ──────────────────────────────────────────────────────────

function SheetMusicTab({ t, soundType, getMIDIOut, midiChannel, playStyle, setPlayStyle, styleMenuOpen, setStyleMenuOpen, STYLES,
  drumPattern, setDrumPattern, drumGenre, setDrumGenre, padMap, drumChannel,
  parsedData, setParsedData, fileName, setFileName, userBpm, setUserBpm,
  drumsEnabled, setDrumsEnabled, sheetOctaveOffset, setSheetOctaveOffset }) {
  const [dragOver,   setDragOver]   = useState(false);
  const [parseError, setParseError] = useState(null);
  const [playing,    setPlaying]    = useState(false);
  const [activeEventIdx, setActiveEventIdx] = useState(-1);
  const [progressPct, setProgressPct] = useState(0);
  const playTimerRef  = useRef(null);
  const timeoutsRef   = useRef([]);
  const loopTimerRef  = useRef(null);
  const rafRef2       = useRef(null);
  const wallStartRef  = useRef(0);
  const totalDurRef   = useRef(0);

  const SF2 = SF;
  const card2 = { background:t.cardBg, border:`1px solid ${t.border}`, padding:"12px 14px", marginBottom:1 };
  const lbl   = { fontSize:11, display:"block", marginBottom:6, color:t.labelColor, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.07em", fontFamily:SF2 };

  const applyXmlText = useCallback((xmlText) => {
    const data = parseMusicXML(xmlText);
    if (!data)                    { setParseError("Could not parse this file. Make sure it's a valid MusicXML export."); setParsedData(null); }
    else if (!data.events.length) { setParseError("No playable notes found in this file."); setParsedData(null); }
    else                          { setParsedData(data); setUserBpm(data.tempo); setPlaying(false); }
  }, []);

  const handleFile = useCallback((file) => {
    if (!file) return;
    setParseError(null);
    setFileName(file.name);

    if (file.name.toLowerCase().endsWith(".mxl")) {
      // .mxl = ZIP-compressed MusicXML
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const zip = await JSZip.loadAsync(e.target.result);

          // Prefer the rootfile listed in META-INF/container.xml
          let xmlText = null;
          const containerEntry = zip.file("META-INF/container.xml");
          if (containerEntry) {
            const containerXml = await containerEntry.async("text");
            const containerDoc = new DOMParser().parseFromString(containerXml, "text/xml");
            const rootPath = containerDoc.querySelector("rootfile")?.getAttribute("full-path");
            if (rootPath) {
              const rootEntry = zip.file(rootPath);
              if (rootEntry) xmlText = await rootEntry.async("text");
            }
          }

          // Fallback: first .xml file that isn't in META-INF
          if (!xmlText) {
            for (const [name, entry] of Object.entries(zip.files)) {
              if (!entry.dir && name.endsWith(".xml") && !name.startsWith("META-INF")) {
                xmlText = await entry.async("text");
                break;
              }
            }
          }

          if (!xmlText) { setParseError("Could not find MusicXML content inside this .mxl file."); setParsedData(null); return; }
          applyXmlText(xmlText);
        } catch (err) {
          setParseError("Failed to read .mxl file: " + err.message);
          setParsedData(null);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      // Plain .musicxml / .xml
      const reader = new FileReader();
      reader.onload = e => applyXmlText(e.target.result);
      reader.readAsText(file);
    }
  }, [applyXmlText]);

  const stopSheet = useCallback(() => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
    if (playTimerRef.current) clearTimeout(playTimerRef.current);
    if (loopTimerRef.current) clearInterval(loopTimerRef.current);
    if (rafRef2.current) cancelAnimationFrame(rafRef2.current);
    // Kill all MIDI sound
    try {
      const midiOut = getMIDIOut();
      if (midiOut) { for (let c=0;c<16;c++) { midiOut.send([0xB0|c,120,0]); midiOut.send([0xB0|c,123,0]); } }
    } catch(e) {}
    // Release instrument + all drum synths
    try { getInstrument(soundType)?.releaseAll?.(); } catch(e) {}
    try { Object.values(drumSynths).forEach(s => { if (s?.triggerRelease) s.triggerRelease(); }); } catch(e) {}
    setPlaying(false);
    setActiveEventIdx(-1);
    setProgressPct(0);
  }, [getMIDIOut, soundType]);

  // Use refs for drum state so scheduleOnce doesn't need them as deps
  const drumsEnabledRef = useRef(drumsEnabled);
  const drumPatternRef2 = useRef(drumPattern);
  const padMapRef2 = useRef(padMap);
  const drumChannelRef2 = useRef(drumChannel);
  const userBpmRef = useRef(userBpm);
  useEffect(() => { drumsEnabledRef.current = drumsEnabled; }, [drumsEnabled]);
  useEffect(() => { drumPatternRef2.current = drumPattern; }, [drumPattern]);
  useEffect(() => { padMapRef2.current = padMap; }, [padMap]);
  useEffect(() => { drumChannelRef2.current = drumChannel; }, [drumChannel]);
  useEffect(() => { userBpmRef.current = userBpm; }, [userBpm]);
  const sheetOctaveRef = useRef(sheetOctaveOffset);
  useEffect(() => { sheetOctaveRef.current = sheetOctaveOffset; }, [sheetOctaveOffset]);

  // Transpose a note name by octave offset, e.g. "C4" + 1 => "C5"
  const transposeNote = useCallback((noteName, offset) => {
    if (!offset) return noteName;
    const m = noteName.match(/^([A-G]#?)(\d)$/);
    if (!m) return noteName;
    const newOct = Math.max(0, Math.min(8, parseInt(m[2]) + offset));
    return m[1] + newOct;
  }, []);

  const scheduleOnce = useCallback((scale) => {
    const midiOut = getMIDIOut();
    const style   = STYLES?.[playStyle] || { durMult:0.85, velMult:1.0, accentMult:1.0, attackSec:0 };
    const octOff  = sheetOctaveRef.current || 0;
    timeoutsRef.current = [];

    if (midiOut) {
      const ch = midiChannel - 1;
      parsedData.events.forEach((e, idx) => {
        const startMs = e.time * scale * 1000;
        const durMs   = e.duration * scale * style.durMult * 1000;
        // Track active event
        const tTrack = setTimeout(() => setActiveEventIdx(idx), startMs);
        timeoutsRef.current.push(tTrack);
        e.notes.forEach((noteName, i) => {
          const n = Math.max(0, Math.min(127, nameToMidi(transposeNote(noteName, octOff))));
          const accentBoost = i === 0 ? style.accentMult : 1;
          const vel = Math.max(1, Math.min(127, Math.round((80 * accentBoost) * style.velMult)));
          const t1 = setTimeout(() => {
            midiOut.send([0x90 | ch, n, vel]);
            const t2 = setTimeout(() => midiOut.send([0x80 | ch, n, 0]), durMs);
            timeoutsRef.current.push(t2);
          }, startMs + i * 8);
          timeoutsRef.current.push(t1);
        });
      });
    } else {
      const inst = getInstrument(soundType);
      // Apply attack envelope
      try {
        if (inst.attack !== undefined) inst.attack = style.attackSec || 0;
        if (inst.set) inst.set({ envelope: { attack: Math.max(0.005, style.attackSec || 0.005) } });
      } catch(e2) {}
      // Schedule via setTimeout so notes can be cancelled on loop/stop
      parsedData.events.forEach((e, idx) => {
        const startMs = e.time * scale * 1000;
        const tTrack = setTimeout(() => setActiveEventIdx(idx), startMs);
        timeoutsRef.current.push(tTrack);
        e.notes.forEach((noteName, i) => {
          const transposed = transposeNote(noteName, octOff);
          const accentBoost = i === 0 ? style.accentMult : 1;
          const v = Math.max(0.02, Math.min(1, 0.7 * accentBoost * style.velMult));
          const dur = e.duration * scale * style.durMult;
          const t1 = setTimeout(() => {
            try { inst.triggerAttackRelease(transposed, dur, Tone.now(), v); } catch(e3) {}
          }, startMs + i * 8);
          timeoutsRef.current.push(t1);
        });
      });
    }

    // ── Drum scheduling (layered on top of sheet music) ──
    const curDrumsEnabled = drumsEnabledRef.current;
    const curDrumPattern = drumPatternRef2.current;
    const curPadMap = padMapRef2.current;
    const curDrumCh = (drumChannelRef2.current || 10) - 1;
    const curBpm = userBpmRef.current;

    if (curDrumsEnabled && curDrumPattern) {
      const midiOut2 = getMIDIOut();
      if (!midiOut2) initDrumSynths();
      const slotSec = (60 / curBpm) / 4; // sixteenth note duration at current BPM
      const drumLoopSec = DRUM_STEPS * slotSec;
      // Figure out how many drum loops fit in the sheet music duration
      const totalSheetSec = parsedData.duration * scale;
      const drumLoops = Math.max(1, Math.ceil(totalSheetSec / drumLoopSec));
      for (let loop = 0; loop < drumLoops; loop++) {
        const loopOffset = loop * drumLoopSec;
        for (let step = 0; step < DRUM_STEPS; step++) {
          DRUM_TRACKS.forEach(track => {
            const vel = curDrumPattern[track.id]?.[step] || 0;
            if (vel <= 0) return;
            const onMs = (loopOffset + step * slotSec) * 1000;
            if (midiOut2) {
              const note = curPadMap?.[track.id]?.midiNote ?? track.defaultNote;
              const offMs = onMs + slotSec * 0.9 * 1000;
              const t1 = setTimeout(() => midiOut2.send([0x90 | curDrumCh, note, vel]), onMs);
              const t2 = setTimeout(() => midiOut2.send([0x80 | curDrumCh, note, 0]), offMs);
              timeoutsRef.current.push(t1, t2);
            } else {
              const t1 = setTimeout(() => triggerDrumSynth(track.id, vel, slotSec * 0.8), onMs);
              timeoutsRef.current.push(t1);
            }
          });
        }
      }
    }
  }, [parsedData, getMIDIOut, midiChannel, soundType, playStyle, STYLES]);

  const playSheet = useCallback(async () => {
    if (playing) { stopSheet(); return; }
    if (!parsedData) return;
    await Tone.start();
    if (soundType === "piano") { const inst = getInstrument(soundType); await Tone.loaded(); }

    const scale = parsedData.tempo / userBpm;
    const totalMs = (parsedData.duration * scale + 0.3) * 1000;
    totalDurRef.current = totalMs;

    scheduleOnce(scale);
    setPlaying(true);
    wallStartRef.current = performance.now();

    // Animate progress
    const animate = () => {
      const elapsed = (performance.now() - wallStartRef.current) % totalMs;
      setProgressPct(elapsed / totalMs);
      rafRef2.current = requestAnimationFrame(animate);
    };
    rafRef2.current = requestAnimationFrame(animate);

    // Loop: re-schedule at end of piece
    loopTimerRef.current = setInterval(() => {
      // Clear old timeouts before re-scheduling
      timeoutsRef.current.forEach(clearTimeout);
      timeoutsRef.current = [];
      wallStartRef.current = performance.now();
      const freshScale = parsedData.tempo / userBpm;
      scheduleOnce(freshScale);
    }, totalMs);
  }, [playing, parsedData, userBpm, soundType, stopSheet, scheduleOnce]);

  // Restart playback when tempo changes during play
  useEffect(() => {
    if (playing && parsedData) {
      stopSheet();
      // Small delay to let stop complete
      const restart = setTimeout(() => playSheet(), 50);
      return () => clearTimeout(restart);
    }
  }, [userBpm]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => stopSheet(), [stopSheet]);

  const fmtDur = s => s >= 60 ? `${Math.floor(s/60)}m ${Math.round(s%60)}s` : `${Math.round(s)}s`;

  return (
    <>
      {/* Drop zone */}
      <div style={card2}>
        <div style={lbl}>MusicXML File</div>
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
          onClick={() => document.getElementById("xml-file-input").click()}
          style={{
            border:`2px dashed ${dragOver ? t.accent : t.inputBorder}`,
            borderRadius:2, padding:"36px 24px", textAlign:"center", cursor:"pointer",
            background: dragOver ? t.accentBg : t.elevatedBg,
            transition:"all 0.08s",
          }}
        >
          <div style={{ fontSize:36, marginBottom:10 }}>🎼</div>
          <div style={{ fontSize:15, fontWeight:600, color:t.textPrimary, fontFamily:SF2, marginBottom:6 }}>
            {fileName || "Drop a MusicXML file here"}
          </div>
          <div style={{ fontSize:12, color:t.textSecondary, fontFamily:SF2 }}>
            {fileName ? "Click to replace" : "or click to browse · .mxl, .musicxml, or .xml from MuseScore, Sibelius, or Finale"}
          </div>
          <input id="xml-file-input" type="file" accept=".musicxml,.xml,.mxl" style={{ display:"none" }}
            onChange={e => { handleFile(e.target.files[0]); e.target.value = ""; }} />
        </div>
        {parseError && (
          <div style={{ marginTop:10, padding:"10px 14px", borderRadius:2,
            background:"rgba(255,69,58,0.10)", border:"1px solid rgba(255,69,58,0.28)",
            fontSize:13, color:"#FF453A", fontFamily:SF2 }}>
            {parseError}
          </div>
        )}
      </div>

      {/* Parsed info + playback */}
      {parsedData && (
        <div style={card2}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:14 }}>
            <div>
              <div style={{ fontSize:20, fontWeight:700, color:t.textPrimary, fontFamily:SF2, marginBottom:8, letterSpacing:"-0.02em" }}>
                {parsedData.title}
              </div>
              <div style={{ display:"flex", gap:18, flexWrap:"wrap", alignItems:"flex-end" }}>
                {[
                  ["Note events", parsedData.events.length],
                  ["Duration",   fmtDur(parsedData.duration * (parsedData.tempo / userBpm))],
                ].map(([k,v]) => (
                  <div key={k} style={{ fontFamily:SF2 }}>
                    <div style={{ fontSize:10, fontWeight:600, color:t.labelColor, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:2 }}>{k}</div>
                    <div style={{ fontSize:15, fontWeight:600, color:t.accent }}>{v}</div>
                  </div>
                ))}
                {/* Tempo control */}
                <div style={{ fontFamily:SF2 }}>
                  <div style={{ fontSize:10, fontWeight:600, color:t.labelColor, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:4 }}>
                    Tempo {parsedData.tempo !== userBpm && <span style={{ color:t.textTertiary, fontWeight:400, textTransform:"none" }}>(original: {parsedData.tempo})</span>}
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <button onClick={() => setUserBpm(b => Math.max(20, b - 1))}
                      style={{ fontFamily:SF2, fontSize:13, fontWeight:600, width:26, height:26, borderRadius:2,
                        border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer", lineHeight:1 }}>−</button>
                    <input
                      type="text" inputMode="numeric"
                      value={userBpm}
                      onChange={e => {
                        const raw = e.target.value.replace(/[^0-9]/g, "");
                        if (raw === "") return;
                        const v = parseInt(raw);
                        if (!isNaN(v) && v >= 1 && v <= 999) setUserBpm(v);
                      }}
                      onBlur={() => { if (userBpm < 20) setUserBpm(20); if (userBpm > 300) setUserBpm(300); }}
                      onKeyDown={e => {
                        if (e.key === "ArrowUp") { e.preventDefault(); setUserBpm(b => Math.min(300, b + 1)); }
                        if (e.key === "ArrowDown") { e.preventDefault(); setUserBpm(b => Math.max(20, b - 1)); }
                        if (e.key === "Enter") e.target.blur();
                      }}
                      style={{ fontFamily:SF2, fontSize:14, fontWeight:700, textAlign:"center",
                        width:58, padding:"4px 6px", borderRadius:2,
                        border:`1px solid ${t.inputBorder}`, background:t.inputBg,
                        color:t.inputColor }}
                    />
                    <button onClick={() => setUserBpm(b => Math.min(300, b + 1))}
                      style={{ fontFamily:SF2, fontSize:13, fontWeight:600, width:26, height:26, borderRadius:2,
                        border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer", lineHeight:1 }}>+</button>
                    {parsedData.tempo !== userBpm && (
                      <button onClick={() => setUserBpm(parsedData.tempo)}
                        style={{ fontFamily:SF2, fontSize:11, fontWeight:500, padding:"4px 10px", borderRadius:2,
                          border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.textSecondary, cursor:"pointer" }}>
                        Reset
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div style={{ display:"flex", gap:8, alignItems:"center", flexShrink:0, alignSelf:"flex-start" }}>
              {/* Style dropdown */}
              {STYLES && (
                <div style={{ position:"relative" }}>
                  <button onClick={() => setStyleMenuOpen(o => !o)}
                    style={{ fontFamily:SF2, fontSize:12, fontWeight:500, padding:"8px 12px", borderRadius:2,
                      border:`1px solid ${playStyle!=="normal"?t.accentBorder:t.btnBorder}`,
                      background:playStyle!=="normal"?t.accentBg:t.btnBg,
                      color:playStyle!=="normal"?t.accent:t.btnColor, cursor:"pointer", display:"flex", alignItems:"center", gap:5 }}>
                    <span style={{ fontSize:10, opacity:0.7, textTransform:"uppercase", letterSpacing:"0.05em" }}>Style:</span>
                    <span>{STYLES[playStyle]?.label || "Normal"}</span>
                    <span style={{ fontSize:9, opacity:0.6 }}>▾</span>
                  </button>
                  {styleMenuOpen && (
                    <>
                      <div onClick={() => setStyleMenuOpen(false)} style={{ position:"fixed", inset:0, zIndex:50 }} />
                      <div style={{ position:"absolute", top:"calc(100% + 6px)", right:0, zIndex:51, minWidth:170,
                          background:t.cardBg, border:`1px solid ${t.border}`, borderRadius:2,
                          padding:4, display:"flex", flexDirection:"column", gap:1 }}>
                        {Object.entries(STYLES).map(([key, cfg]) => (
                          <button key={key} onClick={() => { setPlayStyle(key); setStyleMenuOpen(false); }}
                            style={{ fontFamily:SF2, fontSize:12, fontWeight:playStyle===key?700:500,
                              padding:"7px 11px", borderRadius:2, border:"none", textAlign:"left",
                              background:playStyle===key?t.accentBg:"transparent",
                              color:playStyle===key?t.accent:t.textPrimary, cursor:"pointer" }}
                            onMouseEnter={e=>{ if(playStyle!==key) e.currentTarget.style.background=t.elevatedBg; }}
                            onMouseLeave={e=>{ if(playStyle!==key) e.currentTarget.style.background="transparent"; }}>
                            {cfg.label} {playStyle===key && "✓"}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
              <button onClick={playSheet} style={{
                fontFamily:SF2, fontSize:14, fontWeight:600,
                padding:"11px 30px", borderRadius:2, border:"none",
                background: playing ? "#FF453A" : t.accent,
                color:"#FFFFFF", cursor:"pointer", transition:"background 0.15s",
              }}>
                {playing ? "⬛ Stop" : "▶  Play"}
              </button>
            </div>

            {/* ── Drum Layer ── */}
            <div style={{ marginTop:12, display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
              <button onClick={() => setDrumsEnabled(d => !d)}
                style={{ fontFamily:SF2, fontSize:11, fontWeight:600, padding:"6px 14px", borderRadius:2,
                  border:`1px solid ${drumsEnabled ? "rgba(255,149,0,0.5)" : t.btnBorder}`,
                  background: drumsEnabled ? "rgba(255,149,0,0.12)" : t.btnBg,
                  color: drumsEnabled ? "#FF9500" : t.btnColor, cursor:"pointer", transition:"all 0.12s" }}>
                🥁 Drums {drumsEnabled ? "ON" : "OFF"}
              </button>
              {drumsEnabled && (
                <>
                  <select value={drumGenre} onChange={e => setDrumGenre(e.target.value)}
                    style={{ fontFamily:SF2, fontSize:11, padding:"5px 10px", borderRadius:2,
                      border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.textPrimary, cursor:"pointer" }}>
                    {Object.entries(DRUM_GENRES).map(([k, g]) => (
                      <option key={k} value={k}>{g.label}</option>
                    ))}
                  </select>
                  <button onClick={() => {
                    const genre = DRUM_GENRES[drumGenre];
                    if (genre) {
                      const fresh = genre.generate();
                      DRUM_TRACKS.forEach(tr => { if (!fresh[tr.id]) fresh[tr.id] = emptyDrumTrack(); });
                      setDrumPattern(fresh);
                    }
                  }} style={{ fontFamily:SF2, fontSize:11, fontWeight:500, padding:"5px 12px", borderRadius:2,
                    border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer" }}>
                    Generate
                  </button>
                  {drumPattern && (
                    <span style={{ fontSize:10, color:t.textTertiary, fontFamily:SF2 }}>
                      Pattern loaded · {DRUM_TRACKS.filter(tr => drumPattern[tr.id]?.some(v => v > 0)).length} active tracks
                    </span>
                  )}
                  {!drumPattern && (
                    <span style={{ fontSize:10, color:"#FF9500", fontFamily:SF2, fontWeight:600 }}>
                      Click Generate to create a drum pattern
                    </span>
                  )}
                </>
              )}
            </div>

            {/* ── Octave Offset ── */}
            <div style={{ marginTop:10, display:"flex", gap:8, alignItems:"center" }}>
              <span style={{ fontSize:11, fontWeight:600, color:t.labelColor, textTransform:"uppercase", letterSpacing:"0.07em", fontFamily:SF2 }}>Octave</span>
              <button onClick={() => setSheetOctaveOffset(o => Math.max(-3, o - 1))}
                style={{ fontFamily:SF2, fontSize:13, fontWeight:700, width:28, height:28, borderRadius:2,
                  border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer",
                  display:"flex", alignItems:"center", justifyContent:"center" }}>−</button>
              <span style={{ fontFamily:SF2, fontSize:13, fontWeight:600, color:t.textPrimary, minWidth:32, textAlign:"center" }}>
                {sheetOctaveOffset === 0 ? "0" : (sheetOctaveOffset > 0 ? `+${sheetOctaveOffset}` : sheetOctaveOffset)}
              </span>
              <button onClick={() => setSheetOctaveOffset(o => Math.min(3, o + 1))}
                style={{ fontFamily:SF2, fontSize:13, fontWeight:700, width:28, height:28, borderRadius:2,
                  border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer",
                  display:"flex", alignItems:"center", justifyContent:"center" }}>+</button>
              {sheetOctaveOffset !== 0 && (
                <button onClick={() => setSheetOctaveOffset(0)}
                  style={{ fontFamily:SF2, fontSize:10, fontWeight:500, padding:"3px 8px", borderRadius:2,
                    border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.textTertiary, cursor:"pointer" }}>
                  Reset
                </button>
              )}
            </div>
          </div>
          {/* Progress bar + now-playing notes */}
          {playing && (
            <div style={{ marginTop:14 }}>
              {/* Progress bar */}
              <div style={{ height:4, borderRadius:2, background:t.elevatedBg, overflow:"hidden", marginBottom:10 }}>
                <div style={{ height:"100%", width:`${progressPct*100}%`, background:t.accent, borderRadius:2, transition:"width 0.1s linear" }} />
              </div>
              {/* Now playing */}
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <span style={{ width:7, height:7, borderRadius:"50%", background:"#30D158",
                  display:"inline-block",
                  animation:"pulse 1.2s ease-in-out infinite" }} />
                <span style={{ fontSize:12, fontWeight:600, color:"#30D158", fontFamily:SF2, letterSpacing:"0.05em" }}>
                  PLAYING
                </span>
                {activeEventIdx >= 0 && parsedData?.events?.[activeEventIdx] && (
                  <span style={{ fontSize:14, fontWeight:700, color:t.accent, fontFamily:MONO, letterSpacing:"0.06em" }}>
                    {parsedData.events[activeEventIdx].notes.join(" · ")}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Note events display */}
      {parsedData && parsedData.events.length > 0 && (
        <div style={{ ...card2, padding:"14px 18px", maxHeight:200, overflowY:"auto" }}>
          <div style={{ ...lbl, marginBottom:10 }}>Note Events ({parsedData.events.length})</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
            {parsedData.events.map((e, idx) => {
              const isActive = idx === activeEventIdx;
              const isPast   = idx < activeEventIdx;
              return (
                <div key={idx} style={{
                  padding:"4px 8px", borderRadius:2, fontSize:11, fontWeight:isActive?700:500,
                  fontFamily:MONO,
                  background: isActive ? t.accent : isPast ? t.accentBg : t.elevatedBg,
                  color: isActive ? "#FFFFFF" : isPast ? t.accent : t.textSecondary,
                  border: isActive ? `1px solid ${t.accent}` : `1px solid transparent`,
                  transition:"all 0.1s",
                  transform: isActive ? "scale(1.1)" : "scale(1)",
                }}>
                  {e.notes.join("+")}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* How to use */}
      <div style={{ ...card2, background:t.elevatedBg }}>
        <div style={lbl}>How to use</div>
        <p style={{ fontSize:13, color:t.textSecondary, margin:0, lineHeight:1.65, fontFamily:SF2 }}>
          Export a <strong style={{ color:t.textPrimary }}>MusicXML file</strong> from{" "}
          <strong style={{ color:t.textPrimary }}>MuseScore</strong> (free) or Sibelius / Finale via{" "}
          <strong style={{ color:t.textPrimary }}>File → Export → MusicXML</strong>, then drop it here.
          The app parses notes, timing, and tempo — then plays back through the browser or your connected MIDI device.
          Melodies, chords, and multi-voice parts are all supported.
        </p>
      </div>
    </>
  );
}

// ─── Hum-to-Chord Tab ─────────────────────────────────────────────────────────

function HumToChordTab({ t, rootIdx, scaleKey, onChordsReady }) {
  const SF2 = SF;
  const [recording, setRecording]   = useState(false);
  const [analyzing, setAnalyzing]   = useState(false);
  const [humBars,   setHumBars]     = useState(4);
  const [humBpm,    setHumBpm]      = useState(90);
  const [freeMode,  setFreeMode]    = useState(false); // false = use scale, true = chromatic
  const [freeLength,setFreeLength]  = useState(false); // false = fixed bars, true = sing until stop
  const [detected,  setDetected]    = useState(null);  // [{ freq, note, noteIdx, chord, durationSlots }]
  const [countdown, setCountdown]   = useState(0);
  const [level,     setLevel]       = useState(0);     // mic input level 0-1
  const [liveNote,  setLiveNote]    = useState(null);   // { raw, snapped } during recording
  const [currentBar,setCurrentBar]  = useState(0);      // 1-based bar during recording
  const [playingRef_,setPlayingRef] = useState(false);  // true while reference tone/scale plays
  const [metronome, setMetronome]   = useState(true);   // metronome on/off
  const streamRef      = useRef(null);
  const audioCtxRef    = useRef(null);
  const analyserRef    = useRef(null);
  const rafRef         = useRef(null);
  const recordBufRef   = useRef([]);
  const countdownRef   = useRef(null);
  const refTimeouts    = useRef([]);
  const metroTimeouts  = useRef([]);

  // ── Cleanup on unmount ──
  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(tr => tr.stop());
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") audioCtxRef.current.close();
    if (countdownRef.current) clearInterval(countdownRef.current);
    refTimeouts.current.forEach(id => clearTimeout(id));
    metroTimeouts.current.forEach(id => clearTimeout(id));
  }, []);

  // ── Reference tone helpers ──
  const stopReference = () => {
    refTimeouts.current.forEach(id => clearTimeout(id));
    refTimeouts.current = [];
    try { getSampler().releaseAll(); } catch(e) {}
    setPlayingRef(false);
  };

  const playRoot = async () => {
    if (playingRef_) { stopReference(); return; }
    await Tone.start();
    setPlayingRef(true);
    const noteName = NOTES[rootIdx] + "4";
    const inst = getSampler();
    inst.triggerAttackRelease(noteName, 2.0);
    refTimeouts.current.push(setTimeout(() => setPlayingRef(false), 2200));
  };

  const playScale = async () => {
    if (playingRef_) { stopReference(); return; }
    await Tone.start();
    setPlayingRef(true);
    const inst = getSampler();
    const intervals = SCALES[scaleKey].intervals;
    // Play scale ascending + root octave above
    const noteList = [...intervals.map(iv => NOTES[(rootIdx + iv) % 12] + "4"), NOTES[rootIdx] + "5"];
    const gap = 400; // ms between notes
    noteList.forEach((n, i) => {
      refTimeouts.current.push(setTimeout(() => {
        inst.triggerAttackRelease(n, 0.35);
      }, i * gap));
    });
    refTimeouts.current.push(setTimeout(() => setPlayingRef(false), noteList.length * gap + 200));
  };

  // ── Snap to nearest scale note (autotune) ──
  const snapToScale = (noteIdx) => {
    const scaleNotes = SCALES[scaleKey].intervals.map(iv => (rootIdx + iv) % 12);
    let bestNote = noteIdx, bestDist = 99;
    scaleNotes.forEach(sn => {
      const dist = Math.min(Math.abs(noteIdx - sn), 12 - Math.abs(noteIdx - sn));
      if (dist < bestDist) { bestDist = dist; bestNote = sn; }
    });
    return { snapped: bestNote, snappedName: NOTES[bestNote], wasAdjusted: bestNote !== noteIdx };
  };

  // ── Metronome click — plays root note on beat 1, higher octave on other beats ──
  const playClick = (accent) => {
    const rootNote = NOTES[rootIdx];
    const inst = getSampler();
    if (accent) {
      // Beat 1: play root note as reference pitch
      try { inst.triggerAttackRelease(rootNote + "4", 0.3, Tone.now(), 0.35); } catch(e) {}
    } else {
      // Other beats: short quiet tick
      const synth = new Tone.Synth({
        oscillator: { type: "triangle" },
        envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.03 },
        volume: -18,
      }).toDestination();
      synth.triggerAttackRelease(rootNote + "5", 0.02);
      setTimeout(() => synth.dispose(), 200);
    }
  };

  // ── Harmonize a melody note into a chord from the scale ──
  function harmonize(melodyNoteIdx, rootIdx, scaleKey, freeMode) {
    const scale   = SCALES[scaleKey];
    const scaleNotes = scale.intervals.map(iv => (rootIdx + iv) % 12);

    // Find nearest scale degree for the melody note
    let bestDeg = 0, bestDist = 99;
    scaleNotes.forEach((sn, deg) => {
      const dist = Math.min(Math.abs(melodyNoteIdx - sn), 12 - Math.abs(melodyNoteIdx - sn));
      if (dist < bestDist) { bestDist = dist; bestDeg = deg; }
    });

    // Strategy: pick a chord where the melody note is a chord tone (root, 3rd, or 5th)
    // Try: degree where melody=root, degree where melody=3rd, degree where melody=5th
    const candidates = [];
    for (let deg = 0; deg < 7; deg++) {
      const chordRoot = scaleNotes[deg];
      const quality   = scale.qualities[deg];
      const intervals = CHORD_INTERVALS[quality] || CHORD_INTERVALS["maj"];
      const chordTones = intervals.map(iv => (chordRoot + iv) % 12);
      // Is the melody note (or nearest scale match) in this chord?
      const target = freeMode ? melodyNoteIdx : scaleNotes[bestDeg];
      if (chordTones.includes(target)) {
        // Prefer root > 5th > 3rd for a grounded feel
        const toneIdx = chordTones.indexOf(target);
        const priority = toneIdx === 0 ? 0 : toneIdx === 2 ? 1 : 2; // root=best, fifth=good, third=ok
        candidates.push({ deg, quality, noteIdx: chordRoot, priority, display: NOTES[chordRoot] + (quality === "maj" ? "" : quality === "min" ? "m" : quality === "dim" ? "\u00B0" : quality) });
      }
    }
    candidates.sort((a, b) => a.priority - b.priority);
    // If we have candidates, pick best; add some variety with weighted random
    if (candidates.length > 0) {
      // 60% best candidate, 40% second-best for variety
      const pick = candidates.length > 1 && Math.random() > 0.6 ? candidates[1] : candidates[0];
      return { noteIdx: pick.noteIdx, quality: pick.quality, degree: scale.degrees[pick.deg], display: pick.display };
    }
    // Fallback: tonic chord
    return { noteIdx: scaleNotes[0], quality: scale.qualities[0], degree: "I", display: NOTES[scaleNotes[0]] + (scale.qualities[0] === "min" ? "m" : "") };
  }

  // ── Record & analyze ──
  const snapshotsRef = useRef([]);

  const finishRecording = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(tr => tr.stop());
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") audioCtxRef.current.close();
    clearInterval(countdownRef.current);
    metroTimeouts.current.forEach(id => clearTimeout(id));
    metroTimeouts.current = [];
    setRecording(false);
    setLiveNote(null);
    setCurrentBar(0);
    setCountdown(0);
    if (snapshotsRef.current.length > 0) {
      analyzeSnapshots(snapshotsRef.current);
    }
  };

  const startRecording = async () => {
    setDetected(null);
    setAnalyzing(false);
    setLiveNote(null);
    setCurrentBar(0);
    snapshotsRef.current = [];
    metroTimeouts.current.forEach(id => clearTimeout(id));
    metroTimeouts.current = [];
    try {
      await Tone.start();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 4096;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      streamRef.current  = stream;
      audioCtxRef.current = audioCtx;
      analyserRef.current = analyser;

      const sampleRate = audioCtx.sampleRate;
      const buf = new Float32Array(analyser.fftSize);
      const durationSec = freeLength ? 120 : (humBars * 4 * 60) / humBpm; // free: max 2min
      const barDurMs = (4 * 60 / humBpm) * 1000;
      const beatDurMs = (60 / humBpm) * 1000;
      const startTime = Date.now();

      // Countdown timer (counts up in free mode)
      if (freeLength) {
        setCountdown(0);
        countdownRef.current = setInterval(() => {
          setCountdown(Math.floor((Date.now() - startTime) / 1000));
        }, 250);
      } else {
        setCountdown(Math.ceil(durationSec));
        countdownRef.current = setInterval(() => {
          const remaining = Math.max(0, Math.ceil(durationSec - (Date.now() - startTime) / 1000));
          setCountdown(remaining);
        }, 250);
      }

      // Schedule metronome clicks and bar changes (fixed mode only)
      if (!freeLength) {
        if (metronome) {
          for (let bar = 0; bar < humBars; bar++) {
            for (let beat = 0; beat < 4; beat++) {
              const clickTime = bar * barDurMs + beat * beatDurMs;
              metroTimeouts.current.push(setTimeout(() => playClick(beat === 0), clickTime));
            }
            metroTimeouts.current.push(setTimeout(() => setCurrentBar(bar + 1), bar * barDurMs));
          }
        } else {
          for (let bar = 0; bar < humBars; bar++) {
            metroTimeouts.current.push(setTimeout(() => setCurrentBar(bar + 1), bar * barDurMs));
          }
        }
      } else if (metronome) {
        // Free mode: continuous metronome on BPM beats (root on beat 1 of each bar)
        let beatIdx = 0;
        const scheduleBeats = () => {
          const clickTime = beatIdx * beatDurMs;
          if (clickTime > durationSec * 1000) return;
          metroTimeouts.current.push(setTimeout(() => {
            playClick(beatIdx % 4 === 0);
            if (beatIdx % 4 === 0) setCurrentBar(Math.floor(beatIdx / 4) + 1);
          }, clickTime));
          beatIdx++;
          if (beatIdx < 500) scheduleBeats(); // safety limit
        };
        scheduleBeats();
      }

      setRecording(true);

      const captureLoop = () => {
        const elapsed = Date.now() - startTime;
        if (elapsed > durationSec * 1000) {
          finishRecording();
          return;
        }
        analyser.getFloatTimeDomainData(buf);
        let rms = 0;
        for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
        setLevel(Math.min(1, Math.sqrt(rms / buf.length) * 10));
        const freq = detectPitchAutocorr(buf, sampleRate);
        if (freq && freq > 60 && freq < 1200) {
          const midi = 12 * Math.log2(freq / 440) + 69;
          const rawIdx = ((Math.round(midi) % 12) + 12) % 12;
          const rawName = NOTES[rawIdx];
          const { snapped, snappedName, wasAdjusted } = freeMode ? { snapped: rawIdx, snappedName: NOTES[rawIdx], wasAdjusted: false } : snapToScale(rawIdx);
          setLiveNote({ raw: rawName, snapped: snappedName, wasAdjusted, freq: freq.toFixed(0) });
          snapshotsRef.current.push({ time: elapsed, freq, midi, noteIdx: rawIdx });
        } else {
          setLiveNote(null);
        }
        rafRef.current = requestAnimationFrame(captureLoop);
      };
      rafRef.current = requestAnimationFrame(captureLoop);
    } catch (e) {
      console.error("Mic error:", e);
      setRecording(false);
    }
  };

  const stopRecording = () => {
    snapshotsRef.current = snapshotsRef.current.length > 0 ? snapshotsRef.current : [];
    finishRecording();
  };

  // ── Analyze captured pitch snapshots → melody notes → chords ──
  const analyzeSnapshots = (snapshots) => {
    setAnalyzing(true);
    if (snapshots.length < 4) {
      setDetected([]); setAnalyzing(false); return;
    }

    const totalTime = snapshots[snapshots.length - 1].time;

    if (!freeLength) {
      // ── Fixed bars: segment into equal time slices ──
      const segments = humBars;
      const segDur = totalTime / segments;
      const melodyNotes = [];
      for (let s = 0; s < segments; s++) {
        const segStart = s * segDur;
        const segEnd   = (s + 1) * segDur;
        const segSnaps = snapshots.filter(sn => sn.time >= segStart && sn.time < segEnd);
        if (segSnaps.length === 0) { melodyNotes.push(null); continue; }
        const counts = new Array(12).fill(0);
        segSnaps.forEach(sn => counts[sn.noteIdx]++);
        let bestNote = 0, bestCount = 0;
        counts.forEach((c, i) => { if (c > bestCount) { bestCount = c; bestNote = i; } });
        const avgFreq = segSnaps.filter(sn => sn.noteIdx === bestNote).reduce((s, sn) => s + sn.freq, 0) /
                        segSnaps.filter(sn => sn.noteIdx === bestNote).length;
        const snap = freeMode ? { snapped: bestNote, snappedName: NOTES[bestNote], wasAdjusted: false } : snapToScale(bestNote);
        melodyNotes.push({ noteIdx: bestNote, freq: avgFreq, noteName: NOTES[bestNote], count: bestCount, durationMs: segDur, ...snap });
      }
      const results = melodyNotes.map(mn => {
        if (!mn) return null;
        const chord = harmonize(mn.snapped, rootIdx, scaleKey, freeMode);
        return { ...mn, chord };
      });
      setDetected(results);
    } else {
      // ── Free length: detect note changes by tracking pitch stability ──
      const regions = [];
      let curNote = snapshots[0].noteIdx;
      let regionStart = snapshots[0].time;
      let regionSnaps = [snapshots[0]];

      for (let i = 1; i < snapshots.length; i++) {
        const sn = snapshots[i];
        const snapped = freeMode ? sn.noteIdx : snapToScale(sn.noteIdx).snapped;
        const curSnapped = freeMode ? curNote : snapToScale(curNote).snapped;
        if (snapped !== curSnapped) {
          // Note changed — close current region
          const dur = sn.time - regionStart;
          if (dur > 150 && regionSnaps.length > 3) { // min 150ms to count as a note
            regions.push({ noteIdx: curNote, startMs: regionStart, durationMs: dur, snaps: regionSnaps });
          }
          curNote = sn.noteIdx;
          regionStart = sn.time;
          regionSnaps = [sn];
        } else {
          regionSnaps.push(sn);
        }
      }
      // Close final region
      const finalDur = totalTime - regionStart;
      if (finalDur > 150 && regionSnaps.length > 3) {
        regions.push({ noteIdx: curNote, startMs: regionStart, durationMs: finalDur, snaps: regionSnaps });
      }

      const results = regions.map(r => {
        const avgFreq = r.snaps.reduce((s, sn) => s + sn.freq, 0) / r.snaps.length;
        const snap = freeMode ? { snapped: r.noteIdx, snappedName: NOTES[r.noteIdx], wasAdjusted: false } : snapToScale(r.noteIdx);
        const chord = harmonize(snap.snapped, rootIdx, scaleKey, freeMode);
        return { noteIdx: r.noteIdx, freq: avgFreq, noteName: NOTES[r.noteIdx], durationMs: r.durationMs, ...snap, chord };
      });
      setDetected(results);
    }
    setAnalyzing(false);
  };

  // ── Place chords in timeline ──
  const placeInTimeline = () => {
    if (!detected || detected.length === 0) return;
    if (freeLength) {
      // Variable-length chords based on humming duration
      const totalMs = detected.reduce((s, d) => s + (d?.durationMs || 0), 0);
      const slotDurMs = totalMs / 64; // map total duration to 64 slots
      const chords = [];
      detected.forEach(d => {
        if (!d) return;
        const slots = Math.max(1, Math.round((d.durationMs || slotDurMs) / slotDurMs));
        chords.push({ chord: d.chord, lengthSlots: Math.min(slots, 32) });
      });
      onChordsReady(chords);
    } else {
      const chords = detected.map(d => d ? d.chord : null).filter(Boolean);
      onChordsReady(chords);
    }
  };

  const durationSec = (humBars * 4 * 60) / humBpm;

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      {/* ── Settings card ── */}
      <div style={{ background:t.cardBg, borderRadius:0, padding:20, boxShadow:t.cardShadow, border:`1px solid ${t.border}` }}>
        <div style={{ fontSize:18, fontWeight:700, color:t.textPrimary, marginBottom:14, fontFamily:SF2 }}>
          Hum to Chords
        </div>
        <p style={{ fontSize:13, color:t.textSecondary, lineHeight:1.6, marginBottom:16, fontFamily:SF2 }}>
          Hum a melody — one note per bar. The app listens, detects the pitches, and suggests chords that fit under your melody in the selected scale.
        </p>

        <div style={{ display:"flex", gap:20, flexWrap:"wrap", alignItems:"flex-end", marginBottom:16 }}>
          {!freeLength && <div>
            <label style={{ fontSize:11, fontWeight:700, color:t.labelColor, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:4, display:"block", fontFamily:SF2 }}>Bars</label>
            <select value={humBars} onChange={e => setHumBars(Number(e.target.value))}
              style={{ fontFamily:SF2, fontSize:14, padding:"8px 12px", borderRadius:2, border:`1.5px solid ${t.inputBorder}`, background:t.inputBg, color:t.inputColor, cursor:"pointer" }}>
              {[2,3,4,6,8].map(n => <option key={n} value={n}>{n} bars</option>)}
            </select>
          </div>}
          <div>
            <label style={{ fontSize:11, fontWeight:700, color:t.labelColor, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:4, display:"block", fontFamily:SF2 }}>Tempo</label>
            <input type="number" min={40} max={200} value={humBpm} onChange={e => setHumBpm(Number(e.target.value))}
              style={{ fontFamily:SF2, fontSize:14, padding:"8px 12px", borderRadius:2, border:`1.5px solid ${t.inputBorder}`, background:t.inputBg, color:t.inputColor, width:80 }} />
          </div>
          <div>
            <label style={{ fontSize:11, fontWeight:700, color:t.labelColor, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:4, display:"block", fontFamily:SF2 }}>Mode</label>
            <button onClick={() => setFreeMode(f => !f)}
              style={{ fontFamily:SF2, fontSize:13, fontWeight:600, padding:"8px 16px", borderRadius:2,
                border:`1.5px solid ${freeMode ? "#FF9500" : t.accentBorder}`,
                background: freeMode ? "rgba(255,149,0,0.10)" : t.accentBg,
                color: freeMode ? "#FF9500" : t.accent, cursor:"pointer" }}>
              {freeMode ? "Free detection" : "Use selected scale"}
            </button>
          </div>
          <div>
            <label style={{ fontSize:11, fontWeight:700, color:t.labelColor, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:4, display:"block", fontFamily:SF2 }}>Length</label>
            <button onClick={() => setFreeLength(f => !f)}
              style={{ fontFamily:SF2, fontSize:13, fontWeight:600, padding:"8px 16px", borderRadius:2,
                border:`1.5px solid ${freeLength ? "#34C759" : t.inputBorder}`,
                background: freeLength ? "rgba(52,199,89,0.08)" : t.elevatedBg,
                color: freeLength ? "#34C759" : t.textSecondary, cursor:"pointer" }}>
              {freeLength ? "Free length" : "Fixed bars"}
            </button>
          </div>
        </div>

        <div style={{ fontSize:12, color:t.textTertiary, fontFamily:SF2, marginBottom:14 }}>
          {freeLength ? "Free recording — press Stop when done" : `Recording: ${durationSec.toFixed(1)}s (${humBars} bars × ${humBpm} BPM)`}
          {!freeMode && ` · Skala: ${NOTES[rootIdx]} ${SCALE_DESCRIPTIONS[scaleKey]?.label || scaleKey}`}
        </div>

        {/* ── Reference tone buttons ── */}
        <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
          <button onClick={playRoot} disabled={recording}
            style={{ fontFamily:SF2, fontSize:13, fontWeight:600, padding:"8px 18px", borderRadius:2,
              border:`1.5px solid ${playingRef_ ? "#34C759" : t.inputBorder}`,
              background: playingRef_ ? "rgba(52,199,89,0.08)" : t.elevatedBg,
              color: playingRef_ ? "#34C759" : t.textPrimary, cursor: recording ? "not-allowed" : "pointer",
              opacity: recording ? 0.4 : 1, transition:"all 0.08s" }}>
            {playingRef_ ? "Stop" : `Play root (${NOTES[rootIdx]})`}
          </button>
          <button onClick={playScale} disabled={recording}
            style={{ fontFamily:SF2, fontSize:13, fontWeight:600, padding:"8px 18px", borderRadius:2,
              border:`1.5px solid ${t.inputBorder}`, background:t.elevatedBg,
              color:t.textPrimary, cursor: recording ? "not-allowed" : "pointer",
              opacity: recording ? 0.4 : 1, transition:"all 0.08s" }}>
            Play scale
          </button>
          <div style={{ width:1, height:24, background:t.border }} />
          <button onClick={() => setMetronome(m => !m)}
            style={{ fontFamily:SF2, fontSize:13, fontWeight:600, padding:"8px 18px", borderRadius:2,
              border:`1.5px solid ${metronome ? "#34C759" : t.inputBorder}`,
              background: metronome ? "rgba(52,199,89,0.08)" : t.elevatedBg,
              color: metronome ? "#34C759" : t.textTertiary, cursor:"pointer", transition:"all 0.08s" }}>
            Metronome {metronome ? "on" : "off"}
          </button>
        </div>
      </div>

      {/* ── Record card ── */}
      <div style={{ background:t.cardBg, borderRadius:0, padding:20, boxShadow:t.cardShadow, border:`1px solid ${t.border}`, textAlign:"center" }}>
        {/* Live recording display */}
        {recording && (
          <div style={{ marginBottom:14 }}>
            {/* Bar indicator (fixed mode) or elapsed timer (free mode) */}
            {freeLength ? (
              <div style={{ fontSize:36, fontWeight:700, color:t.accent, fontFamily:MONO, marginBottom:8 }}>
                {countdown}s
              </div>
            ) : (
              <div style={{ display:"flex", justifyContent:"center", gap:8, marginBottom:12 }}>
                {Array.from({ length: humBars }, (_, i) => (
                  <div key={i} style={{
                    width:40, height:40, borderRadius:2, display:"flex", alignItems:"center", justifyContent:"center",
                    fontSize:16, fontWeight:700, fontFamily:SF2,
                    background: currentBar === i + 1 ? t.accent : t.elevatedBg,
                    color: currentBar === i + 1 ? "#FFFFFF" : t.textTertiary,
                    border: `2px solid ${currentBar === i + 1 ? t.accent : t.border}`,
                    transition:"all 0.08s",
                    boxShadow: "none",
                  }}>
                    {i + 1}
                  </div>
                ))}
              </div>
            )}
            <div style={{ fontSize:12, fontWeight:600, color:t.textSecondary, fontFamily:SF2, marginBottom:8 }}>
              {currentBar > 0 ? `Bar ${currentBar} of ${humBars}` : "Ready…"}
            </div>

            {/* Live detected note */}
            <div style={{ minHeight:60, display:"flex", alignItems:"center", justifyContent:"center", marginBottom:8 }}>
              {liveNote ? (
                <div>
                  <div style={{ fontSize:48, fontWeight:700, color: liveNote.wasAdjusted ? "#FF9500" : "#34C759",
                    fontFamily:MONO, lineHeight:1 }}>
                    {liveNote.snapped}
                  </div>
                  {liveNote.wasAdjusted && (
                    <div style={{ fontSize:11, color:t.textTertiary, fontFamily:SF2, marginTop:2 }}>
                      sang {liveNote.raw} → snapped to {liveNote.snapped}
                    </div>
                  )}
                  <div style={{ fontSize:10, color:t.textTertiary, fontFamily:MONO }}>
                    {liveNote.freq} Hz
                  </div>
                </div>
              ) : (
                <div style={{ fontSize:16, color:t.textTertiary, fontFamily:SF2 }}>…</div>
              )}
            </div>

            {/* Level meter */}
            <div style={{ height:6, borderRadius:1, background:t.elevatedBg, overflow:"hidden", maxWidth:300, margin:"0 auto", marginBottom:4 }}>
              <div style={{ height:"100%", borderRadius:1, background: level > 0.5 ? "#34C759" : level > 0.15 ? t.accent : t.textTertiary,
                width:`${Math.min(100, level * 100)}%`, transition:"width 0.05s" }} />
            </div>
            <div style={{ fontSize:10, color:t.textTertiary, fontFamily:SF2 }}>{countdown}s remaining</div>
          </div>
        )}

        <button onClick={recording ? stopRecording : startRecording} disabled={analyzing}
          style={{ fontFamily:SF2, fontSize:16, fontWeight:700, padding:"14px 36px", borderRadius:2, border:"none",
            background: recording ? "#FF453A" : analyzing ? t.playDisabledBg : t.accent,
            color: recording || !analyzing ? "#FFFFFF" : t.playDisabledClr,
            cursor: analyzing ? "not-allowed" : "pointer", transition:"all 0.08s",
            boxShadow: "none",
            letterSpacing:"0.05em" }}>
          {recording ? "Stop" : analyzing ? "Analyzing…" : "Start recording"}
        </button>

        {!recording && !analyzing && !detected && (
          <div style={{ fontSize:12, color:t.textTertiary, marginTop:10, fontFamily:SF2 }}>
            Press to start. Hum clearly — one note at a time.
          </div>
        )}
      </div>

      {/* ── Results card ── */}
      {detected && (
        <div style={{ background:t.cardBg, borderRadius:0, padding:20, boxShadow:t.cardShadow, border:`1px solid ${t.border}` }}>
          <div style={{ fontSize:16, fontWeight:700, color:t.textPrimary, marginBottom:14, fontFamily:SF2 }}>
            Results
          </div>

          {detected.length === 0 ? (
            <div style={{ fontSize:13, color:t.textSecondary, fontFamily:SF2 }}>
              No notes detected. Try again — hum louder and more clearly.
            </div>
          ) : (
            <>
              <div style={{ display:"flex", gap:12, flexWrap:"wrap", marginBottom:16 }}>
                {detected.map((d, i) => (
                  <div key={i} style={{ background:t.elevatedBg, borderRadius:2, padding:"14px 18px", minWidth:100,
                    border:`1px solid ${t.border}`, textAlign:"center" }}>
                    <div style={{ fontSize:11, fontWeight:600, color:t.textTertiary, textTransform:"uppercase",
                      letterSpacing:"0.1em", marginBottom:4, fontFamily:SF2 }}>
                      Bar {i + 1}
                    </div>
                    {d ? (
                      <>
                        <div style={{ fontSize:13, color:t.textSecondary, marginBottom:2, fontFamily:SF2 }}>
                          Hummed: <strong style={{ color: d.wasAdjusted ? "#FF9500" : t.textPrimary }}>{d.noteName}</strong>
                          {d.wasAdjusted && (
                            <span style={{ fontSize:11, color:"#FF9500" }}> → {d.snappedName}</span>
                          )}
                        </div>
                        <div style={{ fontSize:10, color:t.textTertiary, fontFamily:MONO, marginBottom:4 }}>
                          {d.freq.toFixed(0)} Hz {d.wasAdjusted ? "(adjusted)" : ""}
                        </div>
                        <div style={{ fontSize:22, fontWeight:700, color:t.accent, fontFamily:SF2 }}>
                          {d.chord.display}
                        </div>
                        <div style={{ fontSize:11, color:t.textTertiary, fontFamily:SF2 }}>
                          {d.chord.degree}
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize:13, color:t.textTertiary, fontFamily:SF2 }}>Silent</div>
                    )}
                  </div>
                ))}
              </div>

              <div style={{ display:"flex", gap:10 }}>
                <button onClick={placeInTimeline}
                  style={{ fontFamily:SF2, fontSize:14, fontWeight:700, padding:"10px 24px", borderRadius:2,
                    border:"none", background:t.accent, color:"#FFFFFF", cursor:"pointer",
                    boxShadow:"none" }}>
                  Place in timeline
                </button>
                <button onClick={() => startRecording()}
                  style={{ fontFamily:SF2, fontSize:14, fontWeight:500, padding:"10px 24px", borderRadius:2,
                    border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer" }}>
                  Try again
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

const SF = "Inter,-apple-system,system-ui,sans-serif";
const MONO = "'JetBrains Mono',monospace";

export default function App() {
  const [soundType,    setSoundType]    = useState("rhodes"); // "piano" | "rhodes"
  const [mode,         setMode]         = useState("chords"); // "chords" | "scales" | "detect"
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [rootDisplay,  setRootDisplay]  = useState("C");
  const [scaleKey,     setScaleKey]     = useState("major");
  const [chordType,    setChordType]    = useState("triad");
  const [timelineItems, setTimelineItems] = useState([]); // { id, chord, startSlot, lengthSlots }
  const [hoveredChord, setHoveredChord] = useState(null);
  const [activeChord,  setActiveChord]  = useState(null);
  const [bpm,          setBpm]          = useState(90);
  const [looping,      setLooping]      = useState(false);
  const [loopEnabled,  setLoopEnabled]  = useState(true);  // repeat vs one-shot
  const loopEnabledRef = useRef(true);
  const [lastAutoSave, setLastAutoSave] = useState(null);
  const fileInputRef = useRef(null);
  const autoSaveTimerRef = useRef(null);
  const initialLoadDoneRef = useRef(false);
  const [playheadPct,  setPlayheadPct]  = useState(0);
  const [arpOn,        setArpOn]        = useState(false);
  const [arpPattern,   setArpPattern]   = useState("up");
  const [arpRate,      setArpRate]      = useState(0.5);
  const [chordOctave,  setChordOctave]  = useState(4);
  const [playStyle,    setPlayStyle]    = useState("normal");
  const [styleMenuOpen,setStyleMenuOpen]= useState(false);
  const [chordInput,   setChordInput]   = useState("");
  const [chordInputErr,setChordInputErr]= useState(false);
  const [midiOutputs,  setMidiOutputs]  = useState([]);
  const [midiOutputId, setMidiOutputId] = useState("off");
  const [midiChannel,  setMidiChannel]  = useState(1);   // chord channel
  const [bassChannel,  setBassChannel]  = useState(2);
  const [melodyChannel2, setMelodyChannel2] = useState(3); // "melodyChannel2" to avoid collision with "melodyChannel" in SheetMusicTab
  const [midiError,    setMidiError]    = useState(null);
  const [midiSyncMode, setMidiSyncMode] = useState("receive"); // "off" | "send" | "receive"
  const midiClockEnabled = midiSyncMode === "send"; // backward compat
  const midiClockRef = useRef(null); // interval ID for clock ticks
  // ── Drum state ──
  const [drumGenre,      setDrumGenre]      = useState("boombap_classic");
  const [drumPattern,    setDrumPattern]    = useState(null); // { kick:[64], snare:[64], ... }
  const [drumChannel,    setDrumChannel]    = useState(10);
  const [lockedTracks,   setLockedTracks]   = useState({});
  const [mutedTracks,    setMutedTracks]    = useState({});
  const [padMapperOpen,  setPadMapperOpen]  = useState(false);
  // ── Fill state ──
  const [fillMode, setFillMode] = useState("off"); // "off" | "manual" | "auto4" | "auto8"
  const fillNextRef = useRef(false); // true = next loop iteration should have a fill
  const fillJustPlayedRef = useRef(false); // true = last loop had fill, add crash on 1
  const loopCountRef = useRef(0); // counts loop iterations for auto-fill
  const fillModeRef = useRef("off");
  // ── Sheet Music state (lifted so it persists across tab switches) ──
  const [sheetParsedData,     setSheetParsedData]     = useState(null);
  const [sheetFileName,       setSheetFileName]       = useState(null);
  const [sheetUserBpm,        setSheetUserBpm]        = useState(120);
  const [sheetDrumsEnabled,   setSheetDrumsEnabled]   = useState(false);
  const [sheetOctaveOffset,   setSheetOctaveOffset]   = useState(0);
  // ── Piano Roll state ──
  const [pianoRollOpen,  setPianoRollOpen]   = useState(false);
  const [pianoRollEdits, setPianoRollEdits]  = useState({}); // key: "noteNum-startSlot" → { velocity, lengthSlots, muted }
  const pianoRollRef = useRef(null);
  // ── Arrangement / Song mode ──
  const [sections, setSections] = useState([]); // [{ id, name, timelineItems, drumPattern, bassLine }]
  const [arrangement, setArrangement] = useState([]); // [sectionId, sectionId, ...] — order of playback
  const [songModeOpen, setSongModeOpen] = useState(false);
  const [editingSectionId, setEditingSectionId] = useState(null);
  // ── Chord rhythm pattern ──
  const [chordPlayPattern, setChordPlayPattern] = useState("sustained");
  const [chordRhythmMutes, setChordRhythmMutes] = useState({}); // { [itemId]: { [hitIndex]: true } }
  // ── Bass line ──
  const [bassLine, setBassLine] = useState([]); // [{ midi, startSlot, lengthSlots, velocity, muted }]
  const [bassPattern, setBassPattern] = useState("root");
  const [bassVisible, setBassVisible] = useState(false);
  // ── Topline / melody ──
  const [melodyLine, setMelodyLine] = useState([]);
  const [melodyPattern, setMelodyPattern] = useState("chordTones");
  const [melodyVisible, setMelodyVisible] = useState(false);
  const [melodySound, setMelodySound] = useState("bell"); // "piano" | "bell" | "pluck"
  // ── Bass sound ──
  const [bassSound, setBassSound] = useState("808"); // "piano" | "808"
  const [bassOctaveOffset, setBassOctaveOffset] = useState(0); // -2..+2
  const [melodyOctaveOffset, setMelodyOctaveOffset] = useState(0); // -2..+2
  // ── Mute controls ──
  const [muteChords, setMuteChords] = useState(false);
  const [muteBass, setMuteBass] = useState(false);
  const [muteMelody, setMuteMelody] = useState(false);
  const [muteDrums, setMuteDrums] = useState(false);
  // Refs for live mute — read inside schedule callbacks so toggling doesn't restart the loop
  const muteChordsRef = useRef(false);
  const muteBassRef = useRef(false);
  const muteMelodyRef = useRef(false);
  const muteDrumsRef = useRef(false);
  useEffect(() => { muteChordsRef.current = muteChords; }, [muteChords]);
  useEffect(() => { muteBassRef.current = muteBass; }, [muteBass]);
  useEffect(() => { muteMelodyRef.current = muteMelody; }, [muteMelody]);
  useEffect(() => { muteDrumsRef.current = muteDrums; }, [muteDrums]);
  // ── Arrangement playback ──
  const [arrangementPlaying, setArrangementPlaying] = useState(false);
  // ── Pad-to-chord mode ──
  const [chordPadMode, setChordPadMode] = useState(false); // when true, incoming MIDI pads trigger chords
  const [drumStep,       setDrumStep]       = useState(-1);
  const [humanize,       setHumanize]       = useState(0);    // 0-100 → timing jitter + velocity variation
  const humanizeRef = useRef(0);
  useEffect(() => { humanizeRef.current = humanize; }, [humanize]);
  const [drumSwing,      setDrumSwing]      = useState(0);    // 0-100 → maps to 0–50% push on off-beats
  const [drumHalfTime,   setDrumHalfTime]   = useState(false);
  const [densityDrums,   setDensityDrums]   = useState(100);  // 0-100 per element
  const [densityBass,    setDensityBass]    = useState(100);
  const [densityMelody,  setDensityMelody]  = useState(100);
  const [densityChords,  setDensityChords]  = useState(100);
  const [variationAmount, setVariationAmount] = useState(0); // 0-100: how much loops mutate
  const variationAmountRef = useRef(0);
  const [energy, setEnergy] = useState(75); // 0-100: overall intensity
  const energyRef = useRef(75);
  const [densitySeed,    setDensitySeed]    = useState(1);    // changes each loop → new random pattern
  const [soloTrack,      setSoloTrack]      = useState(null);  // trackId or null
  const [tripletTracks,  setTripletTracks]  = useState({});    // { hatC: true, bell: true }
  const [drumFavorites,  setDrumFavorites]  = useState([]);    // [{ id, genre, pattern, label }]
  const [padMap, setPadMap] = useState(() =>
    DRUM_TRACKS.reduce((acc, t) => ({ ...acc, [t.id]: { padId:t.defaultPad, midiNote:t.defaultNote }}), {})
  );
  const loopRef    = useRef(null);
  const rafRef     = useRef(null);
  const dragRef    = useRef(null);
  const trackRef   = useRef(null);
  const midiAccess = useRef(null);
  const instRef    = useRef(null);
  const tlTimeoutsRef = useRef([]);
  // Live refs for values read inside scheduling closures
  const drumSwingRef    = useRef(drumSwing);
  const drumHalfTimeRef = useRef(drumHalfTime);
  const densityDrumsRef  = useRef(densityDrums);
  const densityBassRef   = useRef(densityBass);
  const densityMelodyRef = useRef(densityMelody);
  const densityChordsRef = useRef(densityChords);
  const densitySeedRef  = useRef(densitySeed);
  const soloTrackRef    = useRef(soloTrack);
  const mutedTracksRef  = useRef(mutedTracks);
  const tripletTracksRef = useRef(tripletTracks);

  // ── Project Save/Load ──
  const serializeProject = useCallback(() => ({
    version: 1,
    // Musical core
    rootDisplay, scaleKey, chordType, chordOctave, bpm, timelineItems, soundType,
    // Patterns
    drumPattern, drumGenre, bassLine, bassPattern, melodyLine, melodyPattern,
    // Sections/arrangement
    sections, arrangement,
    // Sound settings
    melodySound, bassSound, bassOctaveOffset, melodyOctaveOffset,
    // Playback
    playStyle, chordPlayPattern, chordRhythmMutes, arpOn, arpPattern, arpRate,
    // Drums
    lockedTracks, mutedTracks, soloTrack, tripletTracks, drumSwing, drumHalfTime, drumFavorites, padMap,
    // Density
    densityDrums, densityBass, densityMelody, densityChords,
    // Variation
    variationAmount,
    // Energy
    energy,
    // Fills
    fillMode,
    // Mutes
    muteChords, muteBass, muteMelody, muteDrums,
    // MIDI config
    midiOutputId, midiChannel, bassChannel, melodyChannel2, drumChannel, midiSyncMode,
    // Other
    pianoRollEdits, humanize, loopEnabled,
  }), [
    rootDisplay, scaleKey, chordType, chordOctave, bpm, timelineItems, soundType,
    drumPattern, drumGenre, bassLine, bassPattern, melodyLine, melodyPattern,
    sections, arrangement,
    melodySound, bassSound, bassOctaveOffset, melodyOctaveOffset,
    playStyle, chordPlayPattern, chordRhythmMutes, arpOn, arpPattern, arpRate,
    lockedTracks, mutedTracks, soloTrack, tripletTracks, drumSwing, drumHalfTime, drumFavorites, padMap,
    densityDrums, densityBass, densityMelody, densityChords,
    variationAmount,
    energy,
    fillMode,
    muteChords, muteBass, muteMelody, muteDrums,
    midiOutputId, midiChannel, bassChannel, melodyChannel2, drumChannel, midiSyncMode,
    pianoRollEdits, humanize, loopEnabled,
  ]);

  const loadProject = useCallback((data) => {
    if (!data) return;
    // Musical core
    if (data.rootDisplay !== undefined) setRootDisplay(data.rootDisplay);
    if (data.scaleKey !== undefined) setScaleKey(data.scaleKey);
    if (data.chordType !== undefined) setChordType(data.chordType);
    if (data.chordOctave !== undefined) setChordOctave(data.chordOctave);
    if (data.bpm !== undefined) setBpm(data.bpm);
    if (data.timelineItems !== undefined) setTimelineItems(data.timelineItems);
    if (data.soundType !== undefined) setSoundType(data.soundType);
    // Patterns
    if (data.drumPattern !== undefined) setDrumPattern(data.drumPattern);
    if (data.drumGenre !== undefined) setDrumGenre(data.drumGenre);
    if (data.bassLine !== undefined) setBassLine(data.bassLine);
    if (data.bassPattern !== undefined) setBassPattern(data.bassPattern);
    if (data.melodyLine !== undefined) setMelodyLine(data.melodyLine);
    if (data.melodyPattern !== undefined) setMelodyPattern(data.melodyPattern);
    // Sections/arrangement
    if (data.sections !== undefined) setSections(data.sections);
    if (data.arrangement !== undefined) setArrangement(data.arrangement);
    // Sound settings
    if (data.melodySound !== undefined) setMelodySound(data.melodySound);
    if (data.bassSound !== undefined) setBassSound(data.bassSound);
    if (data.bassOctaveOffset !== undefined) setBassOctaveOffset(data.bassOctaveOffset);
    if (data.melodyOctaveOffset !== undefined) setMelodyOctaveOffset(data.melodyOctaveOffset);
    // Playback
    if (data.playStyle !== undefined) setPlayStyle(data.playStyle);
    if (data.chordPlayPattern !== undefined) setChordPlayPattern(data.chordPlayPattern);
    if (data.chordRhythmMutes !== undefined) setChordRhythmMutes(data.chordRhythmMutes);
    if (data.arpOn !== undefined) setArpOn(data.arpOn);
    if (data.arpPattern !== undefined) setArpPattern(data.arpPattern);
    if (data.arpRate !== undefined) setArpRate(data.arpRate);
    // Drums
    if (data.lockedTracks !== undefined) setLockedTracks(data.lockedTracks);
    if (data.mutedTracks !== undefined) { setMutedTracks(data.mutedTracks); mutedTracksRef.current = data.mutedTracks; }
    if (data.soloTrack !== undefined) { setSoloTrack(data.soloTrack); soloTrackRef.current = data.soloTrack; }
    if (data.tripletTracks !== undefined) { setTripletTracks(data.tripletTracks); tripletTracksRef.current = data.tripletTracks; }
    if (data.drumSwing !== undefined) { setDrumSwing(data.drumSwing); drumSwingRef.current = data.drumSwing; }
    if (data.drumHalfTime !== undefined) { setDrumHalfTime(data.drumHalfTime); drumHalfTimeRef.current = data.drumHalfTime; }
    if (data.drumFavorites !== undefined) setDrumFavorites(data.drumFavorites);
    if (data.padMap !== undefined) setPadMap(data.padMap);
    // Density
    if (data.densityDrums !== undefined) { setDensityDrums(data.densityDrums); densityDrumsRef.current = data.densityDrums; }
    if (data.densityBass !== undefined) { setDensityBass(data.densityBass); densityBassRef.current = data.densityBass; }
    if (data.densityMelody !== undefined) { setDensityMelody(data.densityMelody); densityMelodyRef.current = data.densityMelody; }
    if (data.densityChords !== undefined) { setDensityChords(data.densityChords); densityChordsRef.current = data.densityChords; }
    setDensitySeed(1); densitySeedRef.current = 1;
    // Variation
    if (data.variationAmount !== undefined) { setVariationAmount(data.variationAmount); variationAmountRef.current = data.variationAmount; }
    // Energy
    if (data.energy !== undefined) { setEnergy(data.energy); energyRef.current = data.energy; }
    // Fills
    if (data.fillMode !== undefined) { setFillMode(data.fillMode); fillModeRef.current = data.fillMode; }
    // Mutes
    if (data.muteChords !== undefined) setMuteChords(data.muteChords);
    if (data.muteBass !== undefined) setMuteBass(data.muteBass);
    if (data.muteMelody !== undefined) setMuteMelody(data.muteMelody);
    if (data.muteDrums !== undefined) setMuteDrums(data.muteDrums);
    // MIDI config
    if (data.midiOutputId !== undefined) setMidiOutputId(data.midiOutputId);
    if (data.midiChannel !== undefined) setMidiChannel(data.midiChannel);
    if (data.bassChannel !== undefined) setBassChannel(data.bassChannel);
    if (data.melodyChannel2 !== undefined) setMelodyChannel2(data.melodyChannel2);
    if (data.drumChannel !== undefined) setDrumChannel(data.drumChannel);
    if (data.midiSyncMode !== undefined) setMidiSyncMode(data.midiSyncMode);
    // Other
    if (data.pianoRollEdits !== undefined) setPianoRollEdits(data.pianoRollEdits);
    if (data.humanize !== undefined) setHumanize(data.humanize);
    if (data.loopEnabled !== undefined) { setLoopEnabled(data.loopEnabled); loopEnabledRef.current = data.loopEnabled; }
  }, []);

  // Auto-load from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem("fiskaturet_project");
      if (saved) {
        const data = JSON.parse(saved);
        loadProject(data);
      }
    } catch (e) {
      console.warn("Failed to load saved project:", e);
    }
    // Mark initial load as done after a short delay so auto-save doesn't fire immediately
    setTimeout(() => { initialLoadDoneRef.current = true; }, 500);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save to localStorage (debounced 2s)
  useEffect(() => {
    if (!initialLoadDoneRef.current) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem("fiskaturet_project", JSON.stringify(serializeProject()));
        setLastAutoSave(Date.now());
      } catch (e) {
        console.warn("Auto-save failed:", e);
      }
    }, 2000);
    return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current); };
  }, [serializeProject]);

  // ── MIDI init ──
  const [midiReady, setMidiReady] = useState(false);
  useEffect(() => {
    if (!navigator.requestMIDIAccess) {
      setMidiError("Web MIDI is not supported in this browser. Use Chrome or Edge.");
      return;
    }
    navigator.requestMIDIAccess().then(access => {
      midiAccess.current = access;
      const refresh = () => setMidiOutputs([...access.outputs.values()]);
      refresh();
      access.onstatechange = refresh;
      setMidiReady(true);
    }).catch(() => setMidiError("MIDI access denied. Allow MIDI in browser permissions."));
  }, []);

  // Keep refs in sync with state for live scheduling reads
  useEffect(() => { drumSwingRef.current = drumSwing; }, [drumSwing]);
  useEffect(() => { drumHalfTimeRef.current = drumHalfTime; }, [drumHalfTime]);
  useEffect(() => { densityDrumsRef.current = densityDrums; }, [densityDrums]);
  useEffect(() => { densityBassRef.current = densityBass; }, [densityBass]);
  useEffect(() => { densityMelodyRef.current = densityMelody; }, [densityMelody]);
  useEffect(() => { densityChordsRef.current = densityChords; }, [densityChords]);
  useEffect(() => { densitySeedRef.current = densitySeed; }, [densitySeed]);
  useEffect(() => { variationAmountRef.current = variationAmount; }, [variationAmount]);
  useEffect(() => { energyRef.current = energy; }, [energy]);
  useEffect(() => { soloTrackRef.current = soloTrack; }, [soloTrack]);
  useEffect(() => { mutedTracksRef.current = mutedTracks; }, [mutedTracks]);
  useEffect(() => { tripletTracksRef.current = tripletTracks; }, [tripletTracks]);

  const getMIDIOut = useCallback(() => {
    if (midiOutputId === "off" || !midiAccess.current) return null;
    return midiAccess.current.outputs.get(midiOutputId) || null;
  }, [midiOutputId]);

  const sendMIDINotes = useCallback((noteNames, durationMs) => {
    const out = getMIDIOut();
    if (!out) return false;
    const ch = midiChannel - 1;
    const ns = noteNames.map(nameToMidi);
    ns.forEach((n, i) => {
      const delayMs = i * 13 + Math.random() * 7;
      const vel = Math.floor(82 + Math.random() * 33); // 82–115
      setTimeout(() => {
        out.send([0x90 | ch, n, vel]);
        setTimeout(() => out.send([0x80 | ch, n, 0]), durationMs);
      }, delayMs);
    });
    return true;
  }, [getMIDIOut, midiChannel]);

  const sendMIDISingleNote = useCallback((noteName, durationMs=600) => {
    const out = getMIDIOut();
    if (!out) return false;
    const ch = midiChannel - 1;
    const n  = nameToMidi(noteName);
    out.send([0x90 | ch, n, 100]);
    setTimeout(() => out.send([0x80 | ch, n, 0]), durationMs);
    return true;
  }, [getMIDIOut, midiChannel]);

  // ── MIDI Clock sync ──
  // Sends MIDI Start (0xFA) + Clock ticks (0xF8) at 24 PPQ, and MIDI Stop (0xFC)
  // Returns prerollMs (0 if clock disabled) — callers add this to all note timestamps
  const midiPrerollMs = useRef(0);
  const startMidiClock = useCallback((bpmVal) => {
    const out = getMIDIOut();
    if (!out || !midiClockEnabled) { midiPrerollMs.current = 0; return; }
    // Stop any existing clock
    if (midiClockRef.current) { clearInterval(midiClockRef.current); midiClockRef.current = null; }
    // Send MIDI Start
    try { out.send([0xFA]); } catch(e) {}
    // Send clock ticks at 24 PPQ
    const tickIntervalMs = (60 / bpmVal / 24) * 1000;
    midiClockRef.current = setInterval(() => {
      try { out.send([0xF8]); } catch(e) {}
    }, tickIntervalMs);
    // Preroll: 1 beat of clock before notes start
    midiPrerollMs.current = (60 / bpmVal) * 1000;
  }, [getMIDIOut, midiClockEnabled]);

  const stopMidiClock = useCallback(() => {
    if (midiClockRef.current) { clearInterval(midiClockRef.current); midiClockRef.current = null; }
    const out = getMIDIOut();
    if (out && midiClockEnabled) {
      try { out.send([0xFC]); } catch(e) {} // MIDI Stop
    }
  }, [getMIDIOut, midiClockEnabled]);

  // Update MIDI Clock rate when BPM changes during playback (no Start/Stop, just adjust tick rate)
  useEffect(() => {
    if (!midiClockRef.current || !midiClockEnabled) return;
    const out = getMIDIOut();
    if (!out) return;
    // Re-create the interval at the new BPM rate without sending Start/Stop
    clearInterval(midiClockRef.current);
    const tickIntervalMs = (60 / bpm / 24) * 1000;
    midiClockRef.current = setInterval(() => {
      try { out.send([0xF8]); } catch(e) {}
    }, tickIntervalMs);
  }, [bpm, midiClockEnabled, getMIDIOut]);

  // ── MIDI Clock Receive — derive BPM from incoming 0xF8 ticks ──
  const clockTickTimesRef = useRef([]);
  const clockReceiveCleanup = useRef(null);
  const [externalBpm, setExternalBpm] = useState(null); // non-null = receiving clock
  const [clockDebug, setClockDebug] = useState(""); // debug: tick rate info
  const externalBpmTimeout = useRef(null);
  useEffect(() => {
    // Clean up previous listener
    if (clockReceiveCleanup.current) { clockReceiveCleanup.current(); clockReceiveCleanup.current = null; }
    if (midiSyncMode !== "receive" || !midiReady || !midiAccess.current) { setExternalBpm(null); return; }

    const tickTimes = clockTickTimesRef.current;
    tickTimes.length = 0;

    const onMidiMessage = (e) => {
      const data = e.data;
      if (!data || data.length === 0) return;
      const status = data[0];

      if (status === 0xF8) {
        // Clock tick
        const now = performance.now();
        tickTimes.push(now);
        // Keep last 192 ticks — discard ticks older than 5 seconds
        if (tickTimes.length > 192) tickTimes.shift();
        const cutoff = now - 5000;
        while (tickTimes.length > 0 && tickTimes[0] < cutoff) tickTimes.shift();
        // Need at least 48 ticks for reliable BPM (1 beat at 48 PPQ)
        if (tickTimes.length >= 48) {
          // Use ALL available ticks for maximum averaging accuracy
          const span = now - tickTimes[0];
          const intervals = tickTimes.length - 1;
          const avgTickMs = span / intervals;
          // Auto-detect PPQ: if avg tick interval < 20ms, device sends 48 PPQ
          const detectedPpq = avgTickMs < 20 ? 48 : 24;
          const msPerBeat = avgTickMs * detectedPpq;
          const derivedBpm = Math.round(60000 / msPerBeat);
          setClockDebug(`${detectedPpq}ppq, ${tickTimes.length}ticks, ${avgTickMs.toFixed(2)}ms/tick, beat=${msPerBeat.toFixed(0)}ms → ${derivedBpm}bpm`);
          if (derivedBpm >= 30 && derivedBpm <= 300) {
            setBpm(prev => Math.abs(prev - derivedBpm) >= 1 ? derivedBpm : prev);
            setExternalBpm(derivedBpm);
            // Reset "lost clock" timeout
            if (externalBpmTimeout.current) clearTimeout(externalBpmTimeout.current);
            externalBpmTimeout.current = setTimeout(() => {
              setExternalBpm(null);
              tickTimes.length = 0;
            }, 2000); // 2s without ticks = clock lost
          }
        }
      }
    };

    // Listen on ALL MIDI inputs using addEventListener (not onmidimessage)
    // so we don't conflict with the chord-pad handler which uses onmidimessage
    const inputs = [];
    midiAccess.current.inputs.forEach(input => {
      input.addEventListener("midimessage", onMidiMessage);
      inputs.push(input);
    });

    clockReceiveCleanup.current = () => {
      inputs.forEach(input => { input.removeEventListener("midimessage", onMidiMessage); });
      if (externalBpmTimeout.current) clearTimeout(externalBpmTimeout.current);
    };

    return () => {
      if (clockReceiveCleanup.current) { clockReceiveCleanup.current(); clockReceiveCleanup.current = null; }
    };
  }, [midiSyncMode, midiReady]);

  const t = THEME;

  const card = {
    background:t.cardBg, border:`1px solid ${t.border}`, padding:"12px 14px",
    marginBottom:1,
  };
  const labelStyle = {
    fontSize:9, display:"block", marginBottom:4, color:"rgba(0,0,0,0.40)",
    fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:SF,
  };
  const selectStyle = {
    fontFamily:SF, padding:"4px 8px", borderRadius:2,
    border:`1px solid ${t.inputBorder}`, fontSize:12, fontWeight:500,
    color:t.inputColor, background:t.inputBg,
    cursor:"pointer", appearance:"auto", colorScheme:t.colorScheme,
  };

  const rootIdx      = NOTE_DISPLAY.indexOf(rootDisplay);
  const chords       = getChords(rootIdx, scaleKey, chordType);
  const scaleIntervals = SCALES[scaleKey].intervals;
  const scaleNoteIndices = scaleIntervals.map(iv => (rootIdx+iv)%12);
  const scaleNoteNames   = scaleNoteIndices.map(ni => NOTES[ni]);
  const stepPattern      = getStepPattern(scaleIntervals);
  const scaleInfo        = SCALE_DESCRIPTIONS[scaleKey];

  const displayChord     = hoveredChord || activeChord;
  const highlightedNotes = displayChord ? getChordNoteIndices(displayChord.noteIdx, displayChord.quality) : [];

  // ── Timeline helpers ──────────────────────────────────────────────────────────
  const TIMELINE_SLOTS     = 64;  // 4 bars × 16 sixteenth-notes per bar
  const SLOTS_PER_BAR      = 16;  // 16 sixteenth-notes per bar
  const DEFAULT_CHORD_LEN  = 16;  // one bar by default

  // Playing styles — affect duration, velocity, attack character, sustain and tremolo
  // velMult: how hard the keys are struck (0.3 = gentle, 1.5 = very strong)
  // accentMult: extra boost on first note in chord (1.0 = no accent)
  // attackSec: fade-in time in seconds (0 = instant, 0.15 = gentle fade)
  const STYLES = {
    normal:    { label:"Normal",    durMult:0.85, velMult:1.00, accentMult:1.00, attackSec:0,    sustain:false, tremoloHz:0  },
    sart:      { label:"Gentle",    durMult:1.05, velMult:0.38, accentMult:1.00, attackSec:0.18, sustain:true,  tremoloHz:0  },
    staccato:  { label:"Staccato",  durMult:0.18, velMult:0.80, accentMult:1.00, attackSec:0,    sustain:false, tremoloHz:0  },
    legato:    { label:"Legato",    durMult:1.10, velMult:0.85, accentMult:1.00, attackSec:0.04, sustain:true,  tremoloHz:0  },
    tenuto:    { label:"Tenuto",    durMult:0.95, velMult:0.95, accentMult:1.00, attackSec:0.02, sustain:true,  tremoloHz:0  },
    portato:   { label:"Portato",   durMult:0.55, velMult:0.85, accentMult:1.00, attackSec:0,    sustain:false, tremoloHz:0  },
    accents:   { label:"Accents",   durMult:0.85, velMult:0.78, accentMult:1.55, attackSec:0,    sustain:true,  tremoloHz:0  },
    tremolo:   { label:"Tremolo",   durMult:0.85, velMult:0.70, accentMult:1.00, attackSec:0,    sustain:false, tremoloHz:14 },
    dramatisk: { label:"Dramatic",  durMult:1.00, velMult:1.55, accentMult:1.70, attackSec:0,    sustain:true,  tremoloHz:0  },
  };

  const isSlotFree = (items, startSlot, lengthSlots, excludeId = null) => {
    for (let s = startSlot; s < startSlot + lengthSlots; s++) {
      if (items.some(it => it.id !== excludeId && s >= it.startSlot && s < it.startSlot + it.lengthSlots))
        return false;
    }
    return true;
  };

  // ── Piano Roll helpers ──────────────────────────────────────────────────────
  // Compute note blocks from timeline items for the piano roll view
  const computePianoRollNotes = useCallback(() => {
    const notes = [];
    timelineItems.forEach(item => {
      const intervals = CHORD_INTERVALS[item.chord.quality] || CHORD_INTERVALS["maj"];
      let octave = chordOctave;
      let prev = -1;
      intervals.forEach(iv => {
        const ni = (item.chord.noteIdx + iv) % 12;
        if (ni < prev) octave++;
        prev = ni;
        const midiNum = ni + (octave * 12) + 12; // MIDI note number
        const key = `${midiNum}-${item.startSlot}`;
        const edit = pianoRollEdits[key];
        notes.push({
          key,
          midiNum,
          noteName: NOTES[ni] + octave,
          noteIdx: ni,
          startSlot: item.startSlot,
          lengthSlots: edit?.lengthSlots ?? item.lengthSlots,
          velocity: edit?.velocity ?? 100,
          muted: edit?.muted ?? false,
          chordId: item.id,
        });
        octave = ni < prev ? octave : octave; // reset after use
      });
    });
    return notes;
  }, [timelineItems, chordOctave, pianoRollEdits]);

  const pianoRollNotes = computePianoRollNotes();

  // Get the range of MIDI notes to display
  const getPianoRollRange = useCallback(() => {
    if (pianoRollNotes.length === 0) {
      const low = chordOctave * 12 + 12; // C of current octave
      return { low, high: low + 24 };
    }
    const midiNums = pianoRollNotes.map(n => n.midiNum);
    const minNote = Math.min(...midiNums);
    const maxNote = Math.max(...midiNums);
    // Pad 2 semitones each side, quantize to nearest C
    const low = Math.max(24, Math.floor((minNote - 2) / 12) * 12);
    const high = Math.min(108, Math.ceil((maxNote + 3) / 12) * 12);
    return { low, high: Math.max(high, low + 12) };
  }, [pianoRollNotes, chordOctave]);

  // ── Bass line regeneration ──────────────────────────────────────────────────
  const regenerateBass = useCallback((pattern, items) => {
    const tl = items || timelineItems;
    if (tl.length === 0) { setBassLine([]); return; }
    const bl = generateBassLine(tl, scaleKey, rootIdx, chordOctave, pattern || bassPattern, TIMELINE_SLOTS, bassOctaveOffset);
    setBassLine(bl);
  }, [timelineItems, scaleKey, rootIdx, chordOctave, bassPattern, bassOctaveOffset]);

  // ── Melody regeneration ───────────────────────────────────────────────────
  const regenerateMelody = useCallback((pattern, items) => {
    const tl = items || timelineItems;
    if (tl.length === 0) { setMelodyLine([]); return; }
    const ml = generateMelody(tl, scaleKey, rootIdx, chordOctave, pattern || melodyPattern, TIMELINE_SLOTS, melodyOctaveOffset);
    setMelodyLine(ml);
  }, [timelineItems, scaleKey, rootIdx, chordOctave, melodyPattern, melodyOctaveOffset]);

  // Auto-regenerate bass/melody when octave offset changes
  useEffect(() => { if (bassLine.length > 0) regenerateBass(); }, [bassOctaveOffset]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (melodyLine.length > 0) regenerateMelody(); }, [melodyOctaveOffset]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Section (arrangement) helpers ─────────────────────────────────────────
  const saveSection = useCallback((name) => {
    const sec = {
      id: Date.now() + Math.random(),
      name: name || `Section ${sections.length + 1}`,
      timelineItems: JSON.parse(JSON.stringify(timelineItems)),
      drumPattern: drumPattern ? JSON.parse(JSON.stringify(drumPattern)) : null,
      bassLine: JSON.parse(JSON.stringify(bassLine)),
      melodyLine: JSON.parse(JSON.stringify(melodyLine)),
    };
    setSections(prev => [...prev, sec]);
    return sec;
  }, [timelineItems, drumPattern, bassLine, melodyLine, sections.length]);

  const loadSection = useCallback((secId) => {
    const sec = sections.find(s => s.id === secId);
    if (!sec) return;
    stopLoop();
    setTimelineItems(JSON.parse(JSON.stringify(sec.timelineItems)));
    if (sec.drumPattern) setDrumPattern(JSON.parse(JSON.stringify(sec.drumPattern)));
    setBassLine(JSON.parse(JSON.stringify(sec.bassLine || [])));
    setMelodyLine(JSON.parse(JSON.stringify(sec.melodyLine || [])));
    setEditingSectionId(secId);
  }, [sections]);

  const updateSection = useCallback((secId) => {
    setSections(prev => prev.map(s => s.id === secId ? {
      ...s,
      timelineItems: JSON.parse(JSON.stringify(timelineItems)),
      drumPattern: drumPattern ? JSON.parse(JSON.stringify(drumPattern)) : null,
      bassLine: JSON.parse(JSON.stringify(bassLine)),
      melodyLine: JSON.parse(JSON.stringify(melodyLine)),
    } : s));
  }, [timelineItems, drumPattern, bassLine, melodyLine]);

  const deleteSection = useCallback((secId) => {
    setSections(prev => prev.filter(s => s.id !== secId));
    setArrangement(prev => prev.filter(id => id !== secId));
    if (editingSectionId === secId) setEditingSectionId(null);
  }, [editingSectionId]);

  // ── MIDI file download ────────────────────────────────────────────────────
  const downloadMidi = useCallback(() => {
    const data = exportToMidi({
      timelineItems, drumPattern, bassLine, melodyLine, bpm, chordOctave, padMap,
      pianoRollEdits, TIMELINE_SLOTS, DRUM_TRACKS,
      sections: arrangement.length > 0 ? sections : null,
      arrangement: arrangement.length > 0 ? arrangement : null,
    });
    const blob = new Blob([data], { type: "audio/midi" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "fiskaturet-export.mid";
    a.click();
    URL.revokeObjectURL(url);
  }, [timelineItems, drumPattern, bassLine, bpm, chordOctave, padMap, pianoRollEdits, sections, arrangement]);

  // ── MPC drum program download ─────────────────────────────────────────────
  const downloadDrumProgram = useCallback(() => {
    const xml = exportMpcDrumProgram(padMap, DRUM_TRACKS);
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "fiskaturet-drums.xpm";
    a.click();
    URL.revokeObjectURL(url);
  }, [padMap]);

  // ── Pad-to-chord MIDI input listener ──────────────────────────────────────
  useEffect(() => {
    if (!chordPadMode || !midiAccess.current) return;
    const handleMidiMessage = (e) => {
      const [status, note, velocity] = e.data;
      if ((status & 0xF0) !== 0x90 || velocity === 0) return; // only note-on
      // Map MIDI notes 36-43 (pads A1-A8) to scale degrees I-VII + octave
      const padIdx = note - 36;
      if (padIdx < 0 || padIdx > 7) return;
      const scaleObj = SCALES[scaleKey];
      if (!scaleObj) return;
      const degreeIdx = padIdx % 7;
      const noteIdx = (rootIdx + scaleObj.intervals[degreeIdx]) % 12;
      const quality = scaleObj.qualities[degreeIdx];
      const noteNames = getChordNoteNames(noteIdx, quality, chordOctave);
      playChord(noteNames, soundType);
    };
    // Attach to all MIDI inputs
    const inputs = [...midiAccess.current.inputs.values()];
    inputs.forEach(input => input.onmidimessage = handleMidiMessage);
    return () => {
      inputs.forEach(input => input.onmidimessage = null);
    };
  }, [chordPadMode, scaleKey, rootIdx, chordOctave, soundType]);

  const addChord = (chord) => {
    setActiveChord(chord);
    const noteNames = getChordNoteNames(chord.noteIdx, chord.quality, chordOctave);
    // Find first free slot for a one-bar (8-slot) block
    setTimelineItems(prev => {
      let start = 0;
      while (start < TIMELINE_SLOTS) {
        const len = Math.min(DEFAULT_CHORD_LEN, TIMELINE_SLOTS - start);
        if (isSlotFree(prev, start, len)) {
          return [...prev, { id: Date.now() + Math.random(), chord, startSlot: start, lengthSlots: len }];
        }
        start++;
      }
      return prev; // timeline full
    });
    // Preview the chord
    if (arpOn) {
      const ordered = getArpNotes(noteNames, arpPattern);
      const rateSec = (60 / bpm) * arpRate;
      const rateMs  = rateSec * 1000;
      const midiOut = getMIDIOut();
      if (midiOut) {
        const ch = midiChannel - 1;
        for (let i = 0; i < ordered.length * 2; i++) {
          const n = nameToMidi(ordered[i % ordered.length]);
          const { offsetSec, vel } = arpHumanize(i, rateSec);
          const midiVel = Math.round(vel * 100 + 15);
          setTimeout(() => { midiOut.send([0x90|ch,n,midiVel]); setTimeout(() => midiOut.send([0x80|ch,n,0]), rateMs*0.82); }, i*rateMs + offsetSec*1000);
        }
      } else {
        (async () => {
          await Tone.start();
          const inst = getInstrument(soundType);
          if (soundType === "piano") await Tone.loaded();
          const now = Tone.now();
          for (let i = 0; i < ordered.length * 2; i++) {
            const { offsetSec, vel } = arpHumanize(i, rateSec);
            inst.triggerAttackRelease(ordered[i%ordered.length], rateSec*0.82, now+i*rateSec+offsetSec, vel);
          }
        })();
      }
    } else {
      if (!sendMIDINotes(noteNames, 1500)) playChord(noteNames, soundType);
    }
  };

  // ── Drum generator ──
  const generateDrumPattern = useCallback(() => {
    const genre = DRUM_GENRES[drumGenre];
    if (!genre) return;
    const fresh = genre.generate();
    // Honor locked tracks: keep existing data
    if (drumPattern) {
      Object.keys(lockedTracks).forEach(tid => {
        if (lockedTracks[tid] && drumPattern[tid]) fresh[tid] = drumPattern[tid];
      });
    }
    // Ensure every track exists (empty for unused)
    DRUM_TRACKS.forEach(t => { if (!fresh[t.id]) fresh[t.id] = emptyDrumTrack(); });
    setDrumPattern(fresh);
  }, [drumGenre, drumPattern, lockedTracks]);

  const toggleDrumStep = useCallback((trackId, step) => {
    setDrumPattern(prev => {
      if (!prev) return prev;
      const track = [...prev[trackId]];
      track[step] = track[step] > 0 ? 0 : D_VEL(100);
      return { ...prev, [trackId]: track };
    });
  }, []);

  const stopLoop = () => {
    if (loopRef.current)  { clearInterval(loopRef.current);      loopRef.current = null; }
    if (rafRef.current)   { cancelAnimationFrame(rafRef.current); rafRef.current  = null; }
    // Cancel all pending scheduled notes
    if (tlTimeoutsRef.current) {
      tlTimeoutsRef.current.forEach(id => clearTimeout(id));
      tlTimeoutsRef.current = [];
    }
    // Release all playing Tone.js voices
    try { instRef.current?.releaseAll?.(); } catch(e) {}
    // Stop MIDI Clock
    stopMidiClock();
    // Send MIDI all-notes-off / all-sound-off on every channel, just in case
    try {
      const midiOut = getMIDIOut();
      if (midiOut) {
        for (let c = 0; c < 16; c++) {
          midiOut.send([0xB0|c, 120, 0]); // all sound off
          midiOut.send([0xB0|c, 123, 0]); // all notes off
        }
      }
    } catch(e) {}
    setLooping(false);
    setArrangementPlaying(false);
    setPlayheadPct(0);
    setDrumStep(-1);
  };

  // ── Timeline drag/resize ───────────────────────────────────────────────────
  useEffect(() => {
    const onMouseMove = (e) => {
      if (!dragRef.current || !trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const slotW = rect.width / TIMELINE_SLOTS;
      const dSlots = Math.round((e.clientX - dragRef.current.startX) / slotW);
      const { type, id, origStart, origLength } = dragRef.current;
      setTimelineItems(prev => prev.map(item => {
        if (item.id !== id) return item;
        if (type === "move") {
          const ns = Math.max(0, Math.min(TIMELINE_SLOTS - item.lengthSlots, origStart + dSlots));
          return isSlotFree(prev, ns, item.lengthSlots, id) ? { ...item, startSlot: ns } : item;
        } else {
          const nl = Math.max(1, Math.min(TIMELINE_SLOTS - item.startSlot, origLength + dSlots));
          return isSlotFree(prev, item.startSlot, nl, id) ? { ...item, lengthSlots: nl } : item;
        }
      }));
    };
    const onMouseUp = () => { dragRef.current = null; };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup",   onMouseUp);
    return () => { document.removeEventListener("mousemove", onMouseMove); document.removeEventListener("mouseup", onMouseUp); };
  }, []);

  // ── Timeline playback ──────────────────────────────────────────────────────
  const playTimeline = async () => {
    if (looping) { stopLoop(); return; }
    const hasDrums  = drumPattern && DRUM_TRACKS.some(t => drumPattern[t.id]?.some(v => v > 0));
    if (timelineItems.length === 0 && !hasDrums && bassLine.length === 0 && melodyLine.length === 0) return;
    await Tone.start();
    const midiOut = getMIDIOut();
    let inst = null;
    if (!midiOut) {
      inst = getInstrument(soundType);
      if (soundType === "piano") await Tone.loaded();
    }
    instRef.current = inst;
    loopCountRef.current = 0;
    startMidiClock(bpm);
    const preroll = midiPrerollMs.current; // offset all notes by this much

    const slotSec   = (60 / bpm) * 0.25; // sixteenth-note slots
    const chordEnd  = timelineItems.reduce((m,it) => Math.max(m, it.startSlot + it.lengthSlots), 0);
    const bassEnd   = bassLine.reduce((m,n) => Math.max(m, n.startSlot + n.lengthSlots), 0);
    const melEnd    = melodyLine.reduce((m,n) => Math.max(m, n.startSlot + n.lengthSlots), 0);
    const loopSlots = Math.max(chordEnd, bassEnd, melEnd, hasDrums ? DRUM_STEPS : 0);
    if (loopSlots === 0) return;
    const totalSec  = loopSlots * slotSec;
    const totalMs   = totalSec * 1000;

    // Trackable setTimeout — clearable via stopLoop()
    const schedule = (cb, ms) => {
      const id = setTimeout(() => {
        tlTimeoutsRef.current = tlTimeoutsRef.current.filter(x => x !== id);
        cb();
      }, ms);
      tlTimeoutsRef.current.push(id);
      return id;
    };
    // For MIDI: schedule send using Web MIDI timestamps (driver-level precision)
    // Preroll is added so first notes don't arrive before MPC starts recording
    // Mute is checked ~50ms before the note, giving time to react to live mute toggles
    const MUTE_CHECK_LEAD = 50; // ms before note to check mute state
    const scheduleMidi = (muteRef, out, msg, ms) => {
      const actualMs = ms + preroll; // shift all notes by preroll amount
      const checkMs = Math.max(0, actualMs - MUTE_CHECK_LEAD);
      const id = setTimeout(() => {
        tlTimeoutsRef.current = tlTimeoutsRef.current.filter(x => x !== id);
        if (muteRef.current) return; // muted — skip
        const now = performance.now();
        const sendAt = Math.max(now, now + (actualMs - checkMs - MUTE_CHECK_LEAD));
        try { out.send(msg, sendAt); } catch(e) {}
      }, checkMs);
      tlTimeoutsRef.current.push(id);
    };
    // Mute-aware schedulers — for browser audio, use setTimeout; for MIDI, use timestamp scheduling
    // Preroll added so browser audio stays in sync with MIDI output
    const scheduleChord = (cb, ms) => schedule(() => { if (!muteChordsRef.current) cb(); }, ms + preroll);
    const scheduleBass = (cb, ms) => schedule(() => { if (!muteBassRef.current) cb(); }, ms + preroll);
    const scheduleMelody = (cb, ms) => schedule(() => { if (!muteMelodyRef.current) cb(); }, ms + preroll);
    const scheduleDrum = (cb, ms) => schedule(() => { if (!muteDrumsRef.current) cb(); }, ms + preroll);
    // MIDI-specific schedulers — use hardware timestamps
    const midiChord  = midiOut ? (msg, ms) => scheduleMidi(muteChordsRef, midiOut, msg, ms) : null;
    const midiBass   = midiOut ? (msg, ms) => scheduleMidi(muteBassRef,   midiOut, msg, ms) : null;
    const midiMelody = midiOut ? (msg, ms) => scheduleMidi(muteMelodyRef, midiOut, msg, ms) : null;
    const midiDrum   = midiOut ? (msg, ms) => scheduleMidi(muteDrumsRef,  midiOut, msg, ms) : null;

    // Humanize: timing jitter (ms) + velocity scale — reads live ref
    const hz = () => {
      const h = humanizeRef.current / 100; // 0..1
      if (h === 0) return { tMs: 0, vScale: 1 };
      const maxJitterMs = h * slotSec * 1000 * 0.45; // up to ~45% of a slot at full humanize
      const tMs = (Math.random() - 0.5) * 2 * maxJitterMs;
      const maxVelVar = h * 0.3; // up to ±30% velocity variation
      const vScale = 1 + (Math.random() - 0.5) * 2 * maxVelVar;
      return { tMs, vScale };
    };

    const style = STYLES[playStyle] || STYLES.normal;

    // Apply attack envelope to Tone.js instrument for soft/hard feel
    if (inst) {
      try {
        if (inst.attack !== undefined) {
          // Sampler: direct .attack property controls amplitude envelope attack
          inst.attack = style.attackSec || 0;
        }
        if (inst.set) {
          // PolySynth (Rhodes): set envelope.attack on all voices
          inst.set({ envelope: { attack: Math.max(0.005, style.attackSec || 0.005) } });
        }
      } catch(e) {}
    }

    // Pre-compute piano roll edits lookup for this scheduling pass
    const prEdits = pianoRollEdits;
    const getNoteVelScale = (noteName, startSlot) => {
      // Convert note name to MIDI num for lookup
      const midi = nameToMidi(noteName);
      const key = `${midi}-${startSlot}`;
      const edit = prEdits[key];
      if (edit?.muted) return 0; // muted
      if (edit?.velocity != null) return edit.velocity / 100;
      return 1; // default
    };

    const doSchedule = () => {
      const { velMult: energyVel, densityOffset: energyDensOff } = energyScale(energyRef.current);

      // Chords — always schedule, check mute ref at fire time
      timelineItems.forEach(item => {
        const allNoteNames = getChordNoteNames(item.chord.noteIdx, item.chord.quality, chordOctave);
        // Filter out muted notes from piano roll
        let noteNames = allNoteNames.filter(n => getNoteVelScale(n, item.startSlot) > 0);
        if (noteNames.length === 0) return; // all muted, skip this chord
        // Density: thin chord voicing — deterministic (matches visual)
        const density = Math.max(0, Math.min(100, densityChordsRef.current + energyDensOff));
        const seed = densitySeedRef.current;
        if (density < 100 && noteNames.length > 1) {
          const total = noteNames.length;
          noteNames = noteNames.filter((_, i) => i === 0 || densityPass(seed, "chord", item.startSlot * 100 + i, density, chordNoteImportance(i, total)));
          if (noteNames.length === 0) noteNames = [allNoteNames[0]];
        }
        const startSec  = item.startSlot * slotSec;
        const durSec    = item.lengthSlots * slotSec;
        const styledDur = durSec * style.durMult;
        const ch = midiChannel - 1;

        // Sustain pedal (MIDI only): press at chord start, release just before end
        if (midiOut && style.sustain) {
          midiChord([0xB0|ch, 64, 127], startSec*1000);
          midiChord([0xB0|ch, 64, 0],   (startSec + durSec*0.97)*1000);
        }

        if (midiOut) {
          if (arpOn) {
            const rateSec = (60/bpm)*arpRate, rateMs = rateSec*1000;
            const steps = Math.max(1, Math.round(durSec/rateSec));
            const ordered = getArpNotes(noteNames, arpPattern);
            for (let i=0;i<steps;i++) {
              const n = nameToMidi(ordered[i%ordered.length]);
              const {offsetSec,vel} = arpHumanize(i,rateSec);
              const accentBoost = (i%ordered.length===0) ? style.accentMult : 1;
              const midiVel = Math.max(1, Math.min(127, Math.round((vel*100*accentBoost + 15) * style.velMult * energyVel)));
              const onMs  = (startSec + i*rateSec + offsetSec) * 1000;
              const offMs = onMs + rateMs * style.durMult;
              midiChord([0x90|ch, n, midiVel], onMs);
              midiChord([0x80|ch, n, 0],       offMs);
            }
          } else if (style.tremoloHz > 0) {
            const repSec = 1 / style.tremoloHz;
            const reps   = Math.max(1, Math.floor(durSec / repSec));
            const offsets = strumOffsets(noteNames.length), vels = humanVelocities(noteNames.length);
            for (let r=0;r<reps;r++) {
              noteNames.forEach((note,i) => {
                const accentBoost = i===0 ? style.accentMult : 1;
                const midiVel = Math.max(1, Math.min(127, Math.floor((vels[i]*100*accentBoost + 15) * style.velMult * energyVel)));
                const n = nameToMidi(note);
                const onMs  = (startSec + r*repSec + offsets[i]) * 1000;
                const offMs = onMs + repSec * 0.7 * 1000;
                midiChord([0x90|ch, n, midiVel], onMs);
                midiChord([0x80|ch, n, 0],       offMs);
              });
            }
          } else {
            // Apply chord rhythm pattern
            const cpat = CHORD_PLAY_PATTERNS[chordPlayPattern] || CHORD_PLAY_PATTERNS.sustained;
            const hits = cpat.generate(item.lengthSlots);
            const itemMutes = chordRhythmMutes[item.id] || {};
            // Variation strum timing
            const varAmtC = variationAmountRef.current;
            const varSeedC = densitySeedRef.current;
            hits.forEach((hit, hIdx) => {
              if (itemMutes[hIdx]) return; // muted hit
              const hitStartSec = startSec + hit.offset * durSec;
              const hitDurSec = hit.duration * durSec * style.durMult;
              const hitNotes = hit._arpNote != null ? [noteNames[hit._arpNote % noteNames.length]] : noteNames;
              const offsets = strumOffsets(hitNotes.length), vels = humanVelocities(hitNotes.length);
              hitNotes.forEach((note, i) => {
                const { tMs: hzT, vScale: hzV } = hz();
                const accentBoost = i === 0 ? style.accentMult : 1;
                const prVel = getNoteVelScale(note, item.startSlot);
                const midiVel = Math.max(1, Math.min(127, Math.floor((vels[i] * 100 * accentBoost + 15) * style.velMult * prVel * hit.velMult * hzV * energyVel)));
                const n = nameToMidi(note);
                const onMs = Math.max(0, (hitStartSec + offsets[i]) * 1000 + hzT + varStrumOffset(varSeedC, item.startSlot, i, varAmtC));
                const offMs = onMs + hitDurSec * 1000;
                midiChord([0x90 | ch, n, midiVel], onMs);
                midiChord([0x80 | ch, n, 0], offMs);
              });
            });
          }
        } else {
          if (arpOn) {
            const rateSec = (60/bpm)*arpRate, steps = Math.max(1, Math.round(durSec/rateSec));
            const ordered = getArpNotes(noteNames, arpPattern);
            for (let i=0;i<steps;i++) {
              const {offsetSec,vel} = arpHumanize(i,rateSec);
              const accentBoost = (i%ordered.length===0) ? style.accentMult : 1;
              const v = Math.max(0.02, Math.min(1, vel*accentBoost*style.velMult * energyVel));
              const noteDur = rateSec * style.durMult;
              const whenMs = (startSec + i*rateSec + offsetSec) * 1000;
              const note = ordered[i%ordered.length];
              scheduleChord(() => {
                try { inst.triggerAttackRelease(note, noteDur, Tone.now(), v); } catch(e) {}
              }, whenMs);
            }
          } else if (style.tremoloHz > 0) {
            const repSec = 1 / style.tremoloHz;
            const reps   = Math.max(1, Math.floor(durSec / repSec));
            const offsets = strumOffsets(noteNames.length), vels = humanVelocities(noteNames.length);
            for (let r=0;r<reps;r++) {
              noteNames.forEach((note,i) => {
                const accentBoost = i===0 ? style.accentMult : 1;
                const v = Math.max(0.02, Math.min(1, vels[i]*accentBoost*style.velMult * energyVel));
                const whenMs = (startSec + r*repSec + offsets[i]) * 1000;
                scheduleChord(() => {
                  try { inst.triggerAttackRelease(note, repSec*0.7, Tone.now(), v); } catch(e) {}
                }, whenMs);
              });
            }
          } else {
            // Apply chord rhythm pattern (Tone.js path)
            const cpat = CHORD_PLAY_PATTERNS[chordPlayPattern] || CHORD_PLAY_PATTERNS.sustained;
            const hits = cpat.generate(item.lengthSlots);
            const itemMutes = chordRhythmMutes[item.id] || {};
            // Variation strum timing
            const varAmtC2 = variationAmountRef.current;
            const varSeedC2 = densitySeedRef.current;
            hits.forEach((hit, hIdx) => {
              if (itemMutes[hIdx]) return; // muted hit
              const hitStartSec = startSec + hit.offset * durSec;
              const hitDurSec = hit.duration * durSec * style.durMult;
              const hitNotes = hit._arpNote != null ? [noteNames[hit._arpNote % noteNames.length]] : noteNames;
              const offsets = strumOffsets(hitNotes.length), vels = humanVelocities(hitNotes.length);
              hitNotes.forEach((note, i) => {
                const { tMs: hzT, vScale: hzV } = hz();
                const accentBoost = i === 0 ? style.accentMult : 1;
                const prVel = getNoteVelScale(note, item.startSlot);
                const v = Math.max(0.02, Math.min(1, vels[i] * accentBoost * style.velMult * prVel * hit.velMult * hzV * energyVel));
                const whenMs = Math.max(0, (hitStartSec + offsets[i]) * 1000 + hzT + varStrumOffset(varSeedC2, item.startSlot, i, varAmtC2));
                scheduleChord(() => {
                  try { inst.triggerAttackRelease(note, hitDurSec, Tone.now(), v); } catch(e) {}
                }, whenMs);
              });
            });
          }
        }
      });

      // ── Drum scheduling (with swing, half-time, solo, triplets) ──
      // Reads live refs so changes to swing/halftime/solo/mute take effect on next loop
      // Works with MIDI out OR built-in drum synths (no MPC needed)
      if (hasDrums) {
        if (!midiOut) initDrumSynths();
        const drumCh = drumChannel - 1;
        const curSwing     = drumSwingRef.current;
        const curHalfTime  = drumHalfTimeRef.current;
        const curSolo      = soloTrackRef.current;
        const curMuted     = mutedTracksRef.current;
        const curTriplets  = tripletTracksRef.current;
        const swingAmt = (curSwing / 100) * slotSec * 0.5;
        // ── Fill overlay: replace last bar with fill pattern ──
        const isFillLoop = fillNextRef.current;
        const addCrashOn1 = fillJustPlayedRef.current;
        let fillOverlay = null;
        if (isFillLoop && hasDrums) {
          fillOverlay = generateFill(drumGenre);
          fillNextRef.current = false;
          fillJustPlayedRef.current = true;
        } else {
          fillJustPlayedRef.current = false;
        }
        for (let step = 0; step < DRUM_STEPS; step++) {
          DRUM_TRACKS.forEach(track => {
            if (curSolo && curSolo !== track.id) return;
            if (!curSolo && curMuted[track.id]) return;
            const vel = drumPattern[track.id]?.[step] || 0;
            // Fill overlay: replace velocity in last bar (steps 48-63)
            let effectiveVel = vel;
            if (fillOverlay && step >= 48) {
              const fillStep = step - 48;
              const fillVel = fillOverlay[track.id]?.[fillStep];
              if (fillVel !== undefined) effectiveVel = fillVel;
            }
            // Crash on beat 1 after a fill
            if (addCrashOn1 && step === 0 && track.id === "crash") effectiveVel = 110;
            if (effectiveVel <= 0) return;
            if (curHalfTime && !curTriplets[track.id] && step % 2 !== 0) return;
            // Density filter — deterministic (matches visual grid)
            const density = Math.max(0, Math.min(100, densityDrumsRef.current + energyDensOff));
            const seed = densitySeedRef.current;
            if (!densityPass(seed, track.id, step, density, drumImportance(track.id, step))) return;
            // Loop variation mutations
            const varAmt = variationAmountRef.current;
            const varSeed = densitySeedRef.current;
            let mutVel = effectiveVel;
            if (varAmt > 0) {
              if (varDrumRest(varSeed, track.id, step, varAmt, drumImportance(track.id, step))) return;
              mutVel = varDrumVelocity(varSeed, track.id, step, effectiveVel, varAmt);
            }
            const { tMs: hzT, vScale: hzV } = hz();
            const swingDelay = (step % 2 === 1) ? swingAmt : 0;
            const onMs  = Math.max(0, (step * slotSec + swingDelay) * 1000 + hzT);
            const hzVel = Math.max(1, Math.min(127, Math.round(mutVel * hzV * energyVel)));
            if (midiOut) {
              const note  = padMap[track.id]?.midiNote ?? track.defaultNote;
              const offMs = onMs + slotSec * 0.9 * 1000;
              midiDrum([0x90 | drumCh, note, hzVel], onMs);
              midiDrum([0x80 | drumCh, note, 0],   offMs);
            } else {
              scheduleDrum(() => triggerDrumSynth(track.id, hzVel, slotSec * 0.8), onMs);
            }
          });
        }
        // Ghost notes from variation
        const varAmt2 = variationAmountRef.current;
        const varSeed2 = densitySeedRef.current;
        if (varAmt2 >= 30) {
          const prevHit = {}; // track whether previous step had a hit (original or ghost)
          for (let step = 0; step < DRUM_STEPS; step++) {
            DRUM_TRACKS.forEach(track => {
              const existingVel = drumPattern[track.id]?.[step] || 0;
              if (existingVel > 0) { prevHit[track.id] = true; return; }
              if (curSolo && curSolo !== track.id) return;
              if (!curSolo && curMuted[track.id]) return;
              const ghostVelRaw = varDrumGhost(varSeed2, track.id, step, varAmt2, prevHit[track.id]);
              prevHit[track.id] = ghostVelRaw > 0; // track for next step
              if (ghostVelRaw <= 0) return;
              const ghostVel = Math.max(1, Math.min(127, Math.round(ghostVelRaw * energyVel)));
              const swingDelay = (step % 2 === 1) ? swingAmt : 0;
              const onMs = Math.max(0, (step * slotSec + swingDelay) * 1000);
              if (midiOut) {
                const note = padMap[track.id]?.midiNote ?? track.defaultNote;
                const offMs = onMs + slotSec * 0.9 * 1000;
                midiDrum([0x90 | drumCh, note, ghostVel], onMs);
                midiDrum([0x80 | drumCh, note, 0], offMs);
              } else {
                scheduleDrum(() => triggerDrumSynth(track.id, ghostVel, slotSec * 0.8), onMs);
              }
            });
          }
        }
      }

      // ── Bass line scheduling ──
      if (bassLine.length > 0) {
        const bassInst = midiOut ? null : getBassInstrument(bassSound);
        bassLine.forEach((note, nIdx) => {
          if (note.muted) return;
          // Density: skip bass notes — deterministic (matches visual)
          const density = Math.max(0, Math.min(100, densityBassRef.current + energyDensOff));
          const seed = densitySeedRef.current;
          if (!densityPass(seed, "bass", note.startSlot, density, bassImportance(note.startSlot, note.lengthSlots))) return;
          // Loop variation mutations
          const varAmt = variationAmountRef.current;
          const varSeed = densitySeedRef.current;
          let mutMidi = note.midi;
          let mutVel = note.velocity;
          if (varAmt > 0) {
            const octShift = varBassOctave(varSeed, note.startSlot, varAmt);
            mutMidi = Math.max(24, Math.min(96, note.midi + octShift));
            mutVel = varMelodyVelocity(varSeed, note.startSlot + 1000, note.velocity, varAmt);
          }
          const { tMs: hzT, vScale: hzV } = hz();
          const startSec = note.startSlot * slotSec;
          const durSec = note.lengthSlots * slotSec * style.durMult;
          const vel = Math.max(0.02, Math.min(1, (mutVel / 127) * style.velMult * hzV * energyVel));
          const noteName = NOTES[mutMidi % 12] + Math.floor((mutMidi - 12) / 12);
          const onMs = Math.max(0, startSec * 1000 + hzT);
          if (midiOut) {
            const bCh = (bassChannel - 1);
            const midiVelOut = Math.max(1, Math.min(127, Math.round(mutVel * hzV * energyVel)));
            midiBass([0x90 | bCh, mutMidi, midiVelOut], onMs);
            midiBass([0x80 | bCh, mutMidi, 0], onMs + durSec * 1000);
          } else {
            scheduleBass(() => {
              try { bassInst.triggerAttackRelease(noteName, durSec, Tone.now(), vel); } catch(e) {}
            }, onMs);
          }
        });
      }

      // ── Melody / topline scheduling ──
      if (melodyLine.length > 0) {
        const melInst = midiOut ? null : getMelodyInstrument(melodySound);
        const cpatMelVel = (CHORD_PLAY_PATTERNS[chordPlayPattern] || CHORD_PLAY_PATTERNS.sustained).melodyVelMult || 1;
        melodyLine.forEach(note => {
          if (note.muted) return;
          // Density: skip melody notes — deterministic (matches visual)
          const density = Math.max(0, Math.min(100, densityMelodyRef.current + energyDensOff));
          const seed = densitySeedRef.current;
          if (!densityPass(seed, "melody", note.startSlot, density, melodyImportance(note.startSlot, note.lengthSlots, note.velocity))) return;
          // Loop variation mutations
          const varAmt = variationAmountRef.current;
          const varSeed = densitySeedRef.current;
          let mutVel = note.velocity;
          if (varAmt > 0) {
            mutVel = varMelodyVelocity(varSeed, note.startSlot, note.velocity, varAmt);
          }
          const { tMs: hzT, vScale: hzV } = hz();
          const startSec = note.startSlot * slotSec;
          const durSec = note.lengthSlots * slotSec * style.durMult;
          const vel = Math.max(0.02, Math.min(1, (mutVel / 127) * style.velMult * cpatMelVel * hzV * energyVel));
          const noteName = NOTES[note.midi % 12] + Math.floor((note.midi - 12) / 12);
          const onMs = Math.max(0, startSec * 1000 + hzT);
          if (midiOut) {
            const mCh = (melodyChannel2 - 1);
            const midiVel = Math.max(1, Math.min(127, Math.round(mutVel * cpatMelVel * hzV * energyVel)));
            midiMelody([0x90 | mCh, note.midi, midiVel], onMs);
            midiMelody([0x80 | mCh, note.midi, 0], onMs + durSec * 1000);
          } else {
            scheduleMelody(() => {
              try { melInst.triggerAttackRelease(noteName, durSec, Tone.now(), vel); } catch(e) {}
            }, onMs);
          }
        });
      }
    };

    // New density seed each play — visual updates to match
    setDensitySeed(s => s + 1);
    densitySeedRef.current = densitySeedRef.current + 1;
    doSchedule();
    setLooping(true);
    const wallStart = performance.now();
    const totalMsWithPreroll = totalMs + preroll;
    const animate = () => {
      const elapsed = performance.now() - wallStart;
      // During preroll, don't move playhead
      const musicElapsed = Math.max(0, elapsed - preroll);
      // If loop disabled and we've passed one full cycle (after preroll), stop
      if (!loopEnabledRef.current && musicElapsed >= totalMs) {
        stopLoop();
        return;
      }
      const loopElapsed = musicElapsed % totalMs;
      const raw = loopElapsed / totalMs;
      // Chord playhead: scales to filled portion
      setPlayheadPct(raw * (loopSlots / TIMELINE_SLOTS));
      // Drum step marker
      if (hasDrums) {
        const step = Math.floor((loopElapsed / 1000) / slotSec) % DRUM_STEPS;
        setDrumStep(step);
      }
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    loopRef.current = setInterval(() => {
      if (loopEnabledRef.current) {
        loopCountRef.current++;
        // Auto-fill: queue fill before scheduling
        const fm = fillModeRef.current;
        if (fm === "auto4" && loopCountRef.current % 4 === 3) fillNextRef.current = true;
        if (fm === "auto8" && loopCountRef.current % 8 === 7) fillNextRef.current = true;
        // Bump density seed each loop iteration → new random pattern
        densitySeedRef.current = densitySeedRef.current + 1;
        setDensitySeed(densitySeedRef.current);
        doSchedule();
      } else {
        stopLoop();
      }
    }, totalMs);
  };

  // ── Play full arrangement (all sections chained) ─────────────────────────
  const playArrangement = async () => {
    if (looping) { stopLoop(); setArrangementPlaying(false); return; }
    if (arrangement.length === 0) return;

    const resolvedSecs = arrangement.map(id => sections.find(s => s.id === id)).filter(Boolean);
    if (resolvedSecs.length === 0) return;

    await Tone.start();
    const midiOut = getMIDIOut();
    let inst = null;
    if (!midiOut) {
      inst = getInstrument(soundType);
      if (soundType === "piano") await Tone.loaded();
    }
    instRef.current = inst;
    startMidiClock(bpm);
    const preroll = midiPrerollMs.current;

    const slotSec = (60 / bpm) * 0.25;
    const style = STYLES[playStyle] || STYLES.normal;
    const slotsPerSection = TIMELINE_SLOTS;
    const totalSlots = slotsPerSection * resolvedSecs.length;
    const totalSec = totalSlots * slotSec;
    const totalMs = totalSec * 1000;

    if (inst) {
      try {
        if (inst.attack !== undefined) inst.attack = style.attackSec || 0;
        if (inst.set) inst.set({ envelope: { attack: Math.max(0.005, style.attackSec || 0.005) } });
      } catch(e) {}
    }

    const schedule = (cb, ms) => {
      const id = setTimeout(() => { tlTimeoutsRef.current = tlTimeoutsRef.current.filter(x => x !== id); cb(); }, ms);
      tlTimeoutsRef.current.push(id);
    };
    // Mute-aware schedulers for arrangement (preroll added for sync)
    const scheduleChordA = (cb, ms) => schedule(() => { if (!muteChordsRef.current) cb(); }, ms + preroll);
    const scheduleBassA = (cb, ms) => schedule(() => { if (!muteBassRef.current) cb(); }, ms + preroll);
    const scheduleMelodyA = (cb, ms) => schedule(() => { if (!muteMelodyRef.current) cb(); }, ms + preroll);
    // MIDI timestamp-based schedulers for arrangement (avoids dropped notes)
    const MUTE_CHECK_LEAD_A = 50;
    const scheduleMidiA = (muteRef, out, msg, ms) => {
      const actualMs = ms + preroll;
      const checkMs = Math.max(0, actualMs - MUTE_CHECK_LEAD_A);
      const id = setTimeout(() => {
        tlTimeoutsRef.current = tlTimeoutsRef.current.filter(x => x !== id);
        if (muteRef.current) return;
        const now = performance.now();
        const sendAt = Math.max(now, now + (actualMs - checkMs - MUTE_CHECK_LEAD_A));
        try { out.send(msg, sendAt); } catch(e) {}
      }, checkMs);
      tlTimeoutsRef.current.push(id);
    };
    const midiChordA  = midiOut ? (msg, ms) => scheduleMidiA(muteChordsRef, midiOut, msg, ms) : null;
    const midiBassA   = midiOut ? (msg, ms) => scheduleMidiA(muteBassRef,   midiOut, msg, ms) : null;
    const midiMelodyA = midiOut ? (msg, ms) => scheduleMidiA(muteMelodyRef, midiOut, msg, ms) : null;
    const midiDrumA   = midiOut ? (msg, ms) => scheduleMidiA(muteDrumsRef,  midiOut, msg, ms) : null;
    const scheduleDrumA = (cb, ms) => schedule(() => { if (!muteDrumsRef.current) cb(); }, ms + preroll);

    // Humanize helper for arrangement (same logic as main loop)
    const hzA = () => {
      const h = humanizeRef.current / 100;
      if (h === 0) return { tMs: 0, vScale: 1 };
      const maxJitterMs = h * slotSec * 1000 * 0.45;
      const tMs = (Math.random() - 0.5) * 2 * maxJitterMs;
      const maxVelVar = h * 0.3;
      const vScale = 1 + (Math.random() - 0.5) * 2 * maxVelVar;
      return { tMs, vScale };
    };

    const doScheduleArrangement = () => {
      const { velMult: energyVel, densityOffset: energyDensOff } = energyScale(energyRef.current);

      // ── Fill overlay: replace last bar of last section with fill pattern ──
      const isFillLoopA = fillNextRef.current;
      const addCrashOn1A = fillJustPlayedRef.current;
      let fillOverlayA = null;
      if (isFillLoopA) {
        // Find the genre from the last section that has drums
        const lastDrumSec = [...resolvedSecs].reverse().find(s => s.drumPattern);
        if (lastDrumSec) {
          fillOverlayA = generateFill(drumGenre);
          fillNextRef.current = false;
          fillJustPlayedRef.current = true;
        }
      } else {
        fillJustPlayedRef.current = false;
      }
      const lastSecIdx = resolvedSecs.length - 1;

      resolvedSecs.forEach((sec, secIdx) => {
        const offset = secIdx * slotsPerSection;

        // Chords (with rhythm pattern)
        if (sec.timelineItems) {
          const cpat = CHORD_PLAY_PATTERNS[chordPlayPattern] || CHORD_PLAY_PATTERNS.sustained;
          sec.timelineItems.forEach(item => {
            let noteNames = getChordNoteNames(item.chord.noteIdx, item.chord.quality, chordOctave);
            // Density: thin chord voicing — deterministic
            const density = Math.max(0, Math.min(100, densityChordsRef.current + energyDensOff));
            const seed = densitySeedRef.current;
            if (density < 100 && noteNames.length > 1) {
              const total = noteNames.length;
              noteNames = noteNames.filter((_, i) => i === 0 || densityPass(seed, "chord", item.startSlot * 100 + i, density, chordNoteImportance(i, total)));
              if (noteNames.length === 0) noteNames = [getChordNoteNames(item.chord.noteIdx, item.chord.quality, chordOctave)[0]];
            }
            const chordStartSec = (offset + item.startSlot) * slotSec;
            const chordDurSec = item.lengthSlots * slotSec;
            const hits = cpat.generate(item.lengthSlots);
            const itemMutes = chordRhythmMutes[item.id] || {};
            hits.forEach((hit, hIdx) => {
              if (itemMutes[hIdx]) return; // muted hit
              const hitStartSec = chordStartSec + hit.offset * chordDurSec;
              const hitDurSec = hit.duration * chordDurSec * style.durMult;
              const hitNotes = hit._arpNote != null ? [noteNames[hit._arpNote % noteNames.length]] : noteNames;
              if (midiOut) {
                const ch = midiChannel - 1;
                const offsets2 = strumOffsets(hitNotes.length), vels = humanVelocities(hitNotes.length);
                hitNotes.forEach((note, i) => {
                  const { tMs: ht, vScale: hv } = hzA();
                  const midiVel = Math.max(1, Math.min(127, Math.floor((vels[i]*100 + 15) * style.velMult * hit.velMult * hv * energyVel)));
                  const n = nameToMidi(note);
                  const onMs = Math.max(0, (hitStartSec + offsets2[i]) * 1000 + ht);
                  midiChordA([0x90|ch, n, midiVel], onMs);
                  midiChordA([0x80|ch, n, 0], onMs + hitDurSec * 1000);
                });
              } else {
                const offsets2 = strumOffsets(hitNotes.length), vels = humanVelocities(hitNotes.length);
                hitNotes.forEach((note, i) => {
                  const { tMs: ht, vScale: hv } = hzA();
                  const v = Math.max(0.02, Math.min(1, vels[i] * style.velMult * hit.velMult * hv * energyVel));
                  const whenMs = Math.max(0, (hitStartSec + offsets2[i]) * 1000 + ht);
                  scheduleChordA(() => { try { inst.triggerAttackRelease(note, hitDurSec, Tone.now(), v); } catch(e) {} }, whenMs);
                });
              }
            });
          });
        }

        // Bass
        if (sec.bassLine) {
          const bassInst2 = midiOut ? null : getBassInstrument(bassSound);
          sec.bassLine.forEach(note => {
            if (note.muted) return;
            const density = Math.max(0, Math.min(100, densityBassRef.current + energyDensOff));
            const seed = densitySeedRef.current;
            if (!densityPass(seed, "bass", note.startSlot, density, bassImportance(note.startSlot, note.lengthSlots))) return;
            const { tMs: ht, vScale: hv } = hzA();
            const startSec = (offset + note.startSlot) * slotSec;
            const durSec = note.lengthSlots * slotSec * style.durMult;
            const noteName = NOTES[note.midi % 12] + Math.floor((note.midi - 12) / 12);
            const vel = Math.max(0.02, Math.min(1, (note.velocity / 127) * style.velMult * hv * energyVel));
            const onMs = Math.max(0, startSec * 1000 + ht);
            if (midiOut) {
              const midiVel = Math.max(1, Math.min(127, Math.round(note.velocity * hv * energyVel)));
              midiBassA([0x90 | (bassChannel-1), note.midi, midiVel], onMs);
              midiBassA([0x80 | (bassChannel-1), note.midi, 0], onMs + durSec * 1000);
            } else {
              scheduleBassA(() => { try { bassInst2.triggerAttackRelease(noteName, durSec, Tone.now(), vel); } catch(e) {} }, onMs);
            }
          });
        }

        // Melody
        if (sec.melodyLine) {
          const melInst2 = midiOut ? null : getMelodyInstrument(melodySound);
          const cpatMelVelA = (CHORD_PLAY_PATTERNS[chordPlayPattern] || CHORD_PLAY_PATTERNS.sustained).melodyVelMult || 1;
          sec.melodyLine.forEach(note => {
            if (note.muted) return;
            const density = Math.max(0, Math.min(100, densityMelodyRef.current + energyDensOff));
            const seed = densitySeedRef.current;
            if (!densityPass(seed, "melody", note.startSlot, density, melodyImportance(note.startSlot, note.lengthSlots, note.velocity))) return;
            const { tMs: ht, vScale: hv } = hzA();
            const startSec = (offset + note.startSlot) * slotSec;
            const durSec = note.lengthSlots * slotSec * style.durMult;
            const noteName = NOTES[note.midi % 12] + Math.floor((note.midi - 12) / 12);
            const vel = Math.max(0.02, Math.min(1, (note.velocity / 127) * style.velMult * cpatMelVelA * hv * energyVel));
            const onMs = Math.max(0, startSec * 1000 + ht);
            if (midiOut) {
              const midiVel = Math.max(1, Math.min(127, Math.round(note.velocity * cpatMelVelA * hv * energyVel)));
              midiMelodyA([0x90 | (melodyChannel2-1), note.midi, midiVel], onMs);
              midiMelodyA([0x80 | (melodyChannel2-1), note.midi, 0], onMs + durSec * 1000);
            } else {
              scheduleMelodyA(() => { try { melInst2.triggerAttackRelease(noteName, durSec, Tone.now(), vel); } catch(e) {} }, onMs);
            }
          });
        }

        // Drums
        if (sec.drumPattern) {
          if (!midiOut) initDrumSynths();
          const drumCh = drumChannel - 1;
          const isLastSec = secIdx === lastSecIdx;
          DRUM_TRACKS.forEach(track => {
            const steps = sec.drumPattern[track.id];
            if (!steps) return;
            steps.forEach((vel, step) => {
              // Fill overlay: replace velocity in last bar (steps 48-63) of last section
              let effectiveVelA = vel;
              if (fillOverlayA && isLastSec && step >= 48) {
                const fillStep = step - 48;
                const fillVel = fillOverlayA[track.id]?.[fillStep];
                if (fillVel !== undefined) effectiveVelA = fillVel;
              }
              // Crash on beat 1 of first section after a fill
              if (addCrashOn1A && secIdx === 0 && step === 0 && track.id === "crash") effectiveVelA = 110;
              if (effectiveVelA === 0) return;
              // Density filter — deterministic (matches visual)
              const density = Math.max(0, Math.min(100, densityDrumsRef.current + energyDensOff));
              const seed = densitySeedRef.current;
              if (!densityPass(seed, track.id, step, density, drumImportance(track.id, step))) return;
              const { tMs: ht, vScale: hv } = hzA();
              const onMs = Math.max(0, (offset + step) * slotSec * 1000 + ht);
              const hzVel = Math.max(1, Math.min(127, Math.round(effectiveVelA * hv * energyVel)));
              const note = padMap[track.id]?.midiNote ?? track.defaultNote;
              if (midiOut) {
                midiDrumA([0x90 | drumCh, note, hzVel], onMs);
                midiDrumA([0x80 | drumCh, note, 0], onMs + slotSec * 0.9 * 1000);
              } else {
                scheduleDrumA(() => triggerDrumSynth(track.id, hzVel, slotSec * 0.8), onMs);
              }
            });
          });
        }
      });
    };

    setDensitySeed(s => s + 1);
    densitySeedRef.current = densitySeedRef.current + 1;
    doScheduleArrangement();
    setLooping(true);
    setArrangementPlaying(true);
    const wallStart = performance.now();
    const animate = () => {
      const musicElapsed = Math.max(0, performance.now() - wallStart - preroll);
      const loopElapsed = musicElapsed % totalMs;
      const raw = loopElapsed / totalMs;
      setPlayheadPct(raw);
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    loopRef.current = setInterval(() => {
      loopCountRef.current++;
      // Auto-fill: queue fill before scheduling
      const fm = fillModeRef.current;
      if (fm === "auto4" && loopCountRef.current % 4 === 3) fillNextRef.current = true;
      if (fm === "auto8" && loopCountRef.current % 8 === 7) fillNextRef.current = true;
      densitySeedRef.current = densitySeedRef.current + 1;
      setDensitySeed(densitySeedRef.current);
      doScheduleArrangement();
    }, totalMs);
  };

  useEffect(() => () => stopLoop(), []);

  const loopingRef = useRef(false);
  useEffect(() => { loopingRef.current = looping; }, [looping]);
  useEffect(() => { loopEnabledRef.current = loopEnabled; }, [loopEnabled]);
  useEffect(() => {
    if (loopingRef.current) {
      stopLoop();
      // Small delay to let cleanup finish, then restart
      const t = setTimeout(() => playTimeline(), 50);
      return () => clearTimeout(t);
    }
  }, [drumSwing, drumHalfTime, densityDrums, densityBass, densityMelody, densityChords, variationAmount, soloTrack, JSON.stringify(mutedTracks), chordPlayPattern]);

  return (
    <>
      <style>{`
        /* fonts loaded via index.html */
        *{box-sizing:border-box}
        html,body{margin:0;background:${t.pageBg};font-family:${SF}}
        select:focus,button:focus{outline:none}
        option{background:${t.inputBg};color:${t.inputColor}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
        input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-track{background:${t.pageBg}}
        ::-webkit-scrollbar-thumb{background:rgba(0,0,0,0.15);border-radius:0}
        ::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,0.40)}
        .bpm-lcd{font-family:'JetBrains Mono',monospace !important;letter-spacing:0.08em}
      `}</style>

      <div style={{ minHeight:"100vh", background:t.pageBg, padding:"20px 12px", fontFamily:SF }}
        onClick={() => showToolsMenu && setShowToolsMenu(false)}>
        <div style={{ maxWidth:860, margin:"0 auto" }}>

          {/* ── Header ── */}
          <div style={{
            background:"#FFFFFF",
            padding:"14px 16px", marginBottom:0,
            borderBottom:`1px solid rgba(0,0,0,0.13)`,
            display:"flex", justifyContent:"space-between", alignItems:"center",
          }}>
            <div style={{ display:"flex", alignItems:"baseline", gap:12 }}>
              <h1 style={{
                fontSize:16, fontWeight:700, letterSpacing:"0.14em",
                textTransform:"uppercase", color:"#1A1A1A", margin:0,
                fontFamily:MONO,
              }}>
                Fiskaturet
              </h1>
              <p style={{ fontSize:10, color:"#888888", margin:0, fontWeight:500,
                letterSpacing:"0.06em", fontFamily:SF }}>
                {mode==="detect" ? "Key Detector"
                  : mode==="hum" ? "Hum to Chords"
                  : mode==="sheet" ? "Sheet Music"
                  : mode==="drums" ? `Drums · ${DRUM_GENRES[drumGenre]?.label || drumGenre}`
                  : `${rootDisplay} ${scaleInfo.label} · ${mode==="scales" ? "Scales" : chordType==="9" ? "9ths" : chordType==="7" ? "7ths" : "Triads"}`}
              </p>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
              <div style={{ width:5, height:5, borderRadius:"50%", background: looping ? "#5C7C8A" : "#888888" }} />
              <span style={{ fontSize:9, color: looping ? "#5C7C8A" : "#888888", fontWeight:600,
                letterSpacing:"0.08em", textTransform:"uppercase", fontFamily:MONO }}>
                {looping ? "LIVE" : "IDLE"}
              </span>
            </div>
          </div>

          {/* ── Mode switcher ── */}
          <div style={{ display:"flex", gap:0, marginBottom:1, alignItems:"stretch" }}>
            {[
              { key:"chords", label:"Instruments" },
              { key:"drums",  label:"Drums" },
            ].map(({ key: m, label }) => (
              <button key={m} onClick={() => setMode(m)} style={{
                fontFamily:SF, fontSize:12, fontWeight: mode===m ? 700 : 500,
                padding:"8px 18px",
                background: mode===m ? "#fff" : "transparent",
                border: mode===m ? `1px solid ${t.border}` : "1px solid transparent",
                borderBottom: mode===m ? "1px solid #fff" : `1px solid ${t.border}`,
                color: mode===m ? t.textPrimary : "rgba(0,0,0,0.50)",
                cursor:"pointer", transition:"all 0.08s",
                letterSpacing:"0.03em",
              }}>
                {label}
              </button>
            ))}
            {/* Tools dropdown for secondary modes */}
            <div style={{ position:"relative", display:"flex" }}>
              <button onClick={() => setShowToolsMenu(p => !p)} style={{
                fontFamily:SF, fontSize:12, fontWeight: ["scales","detect","sheet","hum"].includes(mode) ? 700 : 500,
                padding:"8px 14px",
                background: ["scales","detect","sheet","hum"].includes(mode) ? "#fff" : "transparent",
                border: ["scales","detect","sheet","hum"].includes(mode) ? `1px solid ${t.border}` : "1px solid transparent",
                borderBottom: ["scales","detect","sheet","hum"].includes(mode) ? "1px solid #fff" : `1px solid ${t.border}`,
                color: ["scales","detect","sheet","hum"].includes(mode) ? t.textPrimary : "rgba(0,0,0,0.50)",
                cursor:"pointer", transition:"all 0.08s", letterSpacing:"0.03em",
              }}>
                {mode==="scales" ? "Scales" : mode==="detect" ? "Detect" : mode==="sheet" ? "Sheet" : mode==="hum" ? "Hum" : "Tools"} ▾
              </button>
              {showToolsMenu && (
                <div style={{
                  position:"absolute", top:"100%", left:0, zIndex:100,
                  background:"#fff", border:`1px solid ${t.border}`, minWidth:150,
                  padding:"4px 0",
                }}>
                  {[
                    { key:"scales", label:"Scale Explorer" },
                    { key:"detect", label:"Key Detector" },
                    { key:"sheet",  label:"Sheet Music" },
                    { key:"hum",    label:"Hum to Chords" },
                  ].map(({ key: m, label }) => (
                    <button key={m} onClick={() => { setMode(m); setShowToolsMenu(false); }} style={{
                      display:"block", width:"100%", textAlign:"left",
                      fontFamily:SF, fontSize:11, fontWeight: mode===m ? 700 : 400,
                      padding:"6px 14px", border:"none",
                      background: mode===m ? t.elevatedBg : "transparent",
                      color: mode===m ? t.textPrimary : t.textSecondary,
                      cursor:"pointer",
                    }}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div style={{ flex:1, borderBottom:`1px solid ${t.border}` }} />
          </div>

          {/* ── Controls (hidden in detect mode) ── */}
          {mode !== "detect" && <div style={card}>
            <div style={{ display:"flex", gap:20, flexWrap:"wrap", alignItems:"flex-end" }}>
              {mode !== "sheet" && mode !== "drums" && <div>
                <label style={labelStyle}>Root</label>
                <select value={rootDisplay}
                  onChange={e => { setRootDisplay(e.target.value); setProgression([]); setActiveChord(null); }}
                  style={selectStyle}>
                  {getSortedRoots(scaleKey).map(n => {
                    const blacks = countBlackKeys(NOTE_DISPLAY.indexOf(n), scaleKey);
                    return <option key={n} value={n}>{n}  ({blacks} black)</option>;
                  })}
                </select>
              </div>}
              {mode !== "sheet" && mode !== "drums" && <div>
                <label style={labelStyle}>Scale</label>
                <select value={scaleKey}
                  onChange={e => { setScaleKey(e.target.value); setProgression([]); setActiveChord(null); }}
                  style={selectStyle}>
                  <option value="major">Major</option>
                  <option value="minor">Minor</option>
                  <option value="dorian">Dorian</option>
                  <option value="phrygian">Phrygian</option>
                  <option value="lydian">Lydian</option>
                  <option value="mixolydian">Mixolydian</option>
                  <option value="locrian">Locrian</option>
                </select>
              </div>}
              {mode === "chords" && (
                <div>
                  <label style={labelStyle}>Type</label>
                  <SegmentedControl
                    value={chordType}
                    options={[{value:"triad",label:"3"},{value:"7",label:"7"},{value:"9",label:"9"}]}
                    onChange={v => setChordType(v)}
                    t={t}
                  />
                </div>
              )}
              {mode !== "drums" && mode !== "hum" && <div>
                <label style={labelStyle}>Sound</label>
                <SegmentedControl
                  value={soundType}
                  options={[{value:"piano",label:"Piano"},{value:"rhodes",label:"Rhodes"}]}
                  onChange={v => setSoundType(v)}
                  t={t}
                />
              </div>}

              {/* MIDI Output */}
              <div>
                <label style={labelStyle}>
                  MIDI Out
                  {midiOutputId !== "off" && (
                    <span style={{ marginLeft:6, color:"#30D158", fontWeight:700 }}>● Connected</span>
                  )}
                </label>
                <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                  {midiError ? (
                    <span style={{ fontSize:12, color:"#FF453A" }}>{midiError}</span>
                  ) : (
                    <>
                      <select
                        value={midiOutputId}
                        onChange={e => setMidiOutputId(e.target.value)}
                        style={{ ...selectStyle, minWidth:180 }}
                      >
                        <option value="off">Off (browser audio)</option>
                        {midiOutputs.map(o => (
                          <option key={o.id} value={o.id}>{o.name}</option>
                        ))}
                      </select>
                      {midiOutputId !== "off" && (
                        <select value={midiSyncMode} onChange={e => setMidiSyncMode(e.target.value)}
                          style={{ fontFamily:SF, fontSize:10, fontWeight:600, padding:"4px 6px", borderRadius:2,
                            border:`1px solid ${midiSyncMode !== "off" ? "rgba(48,209,88,0.5)" : t.btnBorder}`,
                            background: midiSyncMode !== "off" ? "rgba(48,209,88,0.08)" : "transparent",
                            color: midiSyncMode !== "off" ? "#2B9A3E" : t.btnColor, cursor:"pointer",
                            whiteSpace:"nowrap" }}>
                          <option value="off">Sync Off</option>
                          <option value="send">Sync → MPC</option>
                          <option value="receive">Sync ← MPC</option>
                        </select>
                      )}
                    </>
                  )}
                </div>
                {midiOutputId !== "off" && (
                  <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap", marginTop:6 }}>
                    {[
                      { label:"Chords", value:midiChannel, set:setMidiChannel },
                      { label:"Bass",   value:bassChannel, set:setBassChannel },
                      { label:"Melody", value:melodyChannel2, set:setMelodyChannel2 },
                      { label:"Drums",  value:drumChannel, set:setDrumChannel },
                    ].map(({label, value, set}) => (
                      <div key={label} style={{ display:"flex", alignItems:"center", gap:3 }}>
                        <span style={{ fontSize:9, fontWeight:700, color:t.textTertiary, textTransform:"uppercase", letterSpacing:"0.05em", fontFamily:SF }}>{label}</span>
                        <select value={value} onChange={e => set(Number(e.target.value))}
                          style={{ ...selectStyle, width:58, fontSize:11, padding:"3px 4px" }}>
                          {Array.from({length:16},(_,i)=>i+1).map(ch => (
                            <option key={ch} value={ch}>{ch}</option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>}

          {/* ════════════════ KEY DETECTOR MODE ════════════════ */}
          {mode === "detect" && <KeyDetector t={t} />}

          {/* ════════════════ SHEET MUSIC MODE ════════════════ */}
          {mode === "sheet" && (
            <SheetMusicTab
              t={t}
              soundType={soundType}
              getMIDIOut={getMIDIOut}
              midiChannel={midiChannel}
              playStyle={playStyle}
              setPlayStyle={setPlayStyle}
              styleMenuOpen={styleMenuOpen}
              setStyleMenuOpen={setStyleMenuOpen}
              STYLES={STYLES}
              drumPattern={drumPattern}
              setDrumPattern={setDrumPattern}
              drumGenre={drumGenre}
              setDrumGenre={setDrumGenre}
              padMap={padMap}
              drumChannel={drumChannel}
              parsedData={sheetParsedData}
              setParsedData={setSheetParsedData}
              fileName={sheetFileName}
              setFileName={setSheetFileName}
              userBpm={sheetUserBpm}
              setUserBpm={setSheetUserBpm}
              drumsEnabled={sheetDrumsEnabled}
              setDrumsEnabled={setSheetDrumsEnabled}
              sheetOctaveOffset={sheetOctaveOffset}
              setSheetOctaveOffset={setSheetOctaveOffset}
            />
          )}

          {/* ════════════════ HUM-TO-CHORD MODE ════════════════ */}
          {mode === "hum" && (
            <HumToChordTab
              t={t}
              rootIdx={rootIdx}
              scaleKey={scaleKey}
              onChordsReady={(chords) => {
                stopLoop();
                let slot = 0;
                const items = [];
                chords.forEach(c => {
                  if (slot >= TIMELINE_SLOTS) return;
                  // Support both plain chords and { chord, lengthSlots } objects
                  const chord = c.chord || c;
                  const requestedLen = c.lengthSlots || DEFAULT_CHORD_LEN;
                  const len = Math.min(requestedLen, TIMELINE_SLOTS - slot);
                  items.push({ id: Date.now()+Math.random(), chord, startSlot:slot, lengthSlots:len });
                  slot += len;
                });
                setTimelineItems(items);
                const first = chords[0]?.chord || chords[0];
                if (first) setActiveChord(first);
                setMode("chords");
              }}
            />
          )}

          {/* ════════════════ SCALE EXPLORER MODE ════════════════ */}
          {mode === "scales" && (
            <>
              {/* Scale info card */}
              <div style={card}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:12 }}>
                  <div>
                    <div style={{ fontSize:22, fontWeight:700, color:t.textPrimary, letterSpacing:"-0.02em", marginBottom:4 }}>
                      {rootDisplay} {scaleInfo.label}
                    </div>
                    <div style={{ fontSize:13, color:t.accent, fontWeight:600, marginBottom:6 }}>
                      {scaleInfo.mood}
                    </div>
                    <div style={{ fontSize:13, color:t.textSecondary, maxWidth:460, lineHeight:1.5 }}>
                      {scaleInfo.detail}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      const midiOut = getMIDIOut();
                      if (midiOut) {
                        const ch = midiChannel - 1;
                        const secPerNote = 0.32;
                        let octave = 4;
                        scaleNoteIndices.forEach((ni, i) => {
                          if (i > 0 && ni < scaleNoteIndices[i-1]) octave++;
                          const n = nameToMidi(NOTES[ni] + octave);
                          setTimeout(() => {
                            midiOut.send([0x90|ch, n, 100]);
                            setTimeout(() => midiOut.send([0x80|ch, n, 0]), 260);
                          }, i * secPerNote * 1000);
                        });
                      } else {
                        playScale(scaleNoteIndices, soundType);
                      }
                    }}
                    style={{
                      fontFamily:SF, fontSize:13, fontWeight:500,
                      padding:"8px 20px", borderRadius:2, border:"none",
                      background:t.accent, color:"#FFFFFF",
                      cursor:"pointer", whiteSpace:"nowrap", flexShrink:0,
                    }}>
                    Play Scale
                  </button>
                </div>
              </div>

              {/* Piano card — all scale notes highlighted */}
              <div style={card}>
                <div style={{ ...labelStyle, marginBottom:14 }}>Keys in this scale</div>

                {/* Note badges */}
                <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap" }}>
                  {scaleNoteNames.map((name, i) => (
                    <div key={i} style={{
                      display:"flex", flexDirection:"column", alignItems:"center", gap:4,
                    }}>
                      <span style={{
                        background:t.accentBg, color:t.accent,
                        border:`1px solid ${t.accentBorder}`,
                        borderRadius:2, padding:"6px 14px",
                        fontSize:15, fontWeight:700, letterSpacing:"-0.01em", fontFamily:SF,
                        minWidth:44, textAlign:"center",
                      }}>
                        {name}
                      </span>
                      <span style={{ fontSize:10, color:t.textTertiary, fontWeight:500 }}>
                        {SCALES[scaleKey].degrees[i]}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Piano */}
                <div style={{ background:t.pianoRailBg, borderRadius:2, padding:"10px 12px 12px", boxShadow:t.pianoRailShadow }}>
                  <div style={{ background:t.pianoKeysBg, borderRadius:2, overflow:"hidden" }}>
                    <Piano
                      highlightedNotes={scaleNoteIndices}
                      scaleNoteIndices={[]}
                      highlightAllOctaves={true}
                      t={t}
                      onNoteClick={note => { if (!sendMIDISingleNote(note)) playSingleNote(note, soundType); }}
                    />
                  </div>
                </div>

                {/* Step pattern */}
                <div style={{ marginTop:16 }}>
                  <div style={{ ...labelStyle, marginBottom:10 }}>Step pattern</div>
                  <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
                    {stepPattern.map((step, i) => (
                      <div key={i} style={{ display:"flex", alignItems:"center", gap:6 }}>
                        <span style={{
                          background: step==="W" ? t.stepWholeBg : t.stepHalfBg,
                          color:       step==="W" ? t.stepWholeColor : t.stepHalfColor,
                          border:`1px solid ${step==="W" ? t.stepWholeBorder : t.stepHalfBorder}`,
                          borderRadius:2, padding:"5px 14px",
                          fontSize:13, fontWeight:700, fontFamily:SF,
                          minWidth:36, textAlign:"center",
                        }}>
                          {step}
                        </span>
                        {i < stepPattern.length-1 && (
                          <span style={{ color:t.textTertiary, fontSize:12 }}>→</span>
                        )}
                      </div>
                    ))}
                    <span style={{ fontSize:12, color:t.textTertiary, marginLeft:4 }}>
                      W = whole step &nbsp;·&nbsp; H = half step
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ════════════════ DRUMS MODE ════════════════ */}
          {mode === "drums" && (() => {
            // DAW-style micro-button
            const dawBtn = (active, activeColor = t.accent) => ({
              fontFamily:MONO, fontSize:9, fontWeight:700, padding:"1px 4px",
              border:`1px solid ${active ? activeColor : "rgba(0,0,0,0.15)"}`,
              background: active ? (activeColor === t.accent ? "rgba(92,124,138,0.12)" : `${activeColor}18`) : "transparent",
              color: active ? activeColor : "rgba(0,0,0,0.45)", cursor:"pointer", lineHeight:"14px",
              letterSpacing:"0.04em", borderRadius:1, transition:"all 0.08s",
            });
            const dawToolBtn = (primary) => ({
              fontFamily:SF, fontSize:11, fontWeight:600, padding:"4px 12px",
              border: primary ? "none" : "1px solid rgba(0,0,0,0.12)",
              background: primary ? t.accent : "transparent",
              color: primary ? "#fff" : t.textSecondary,
              cursor:"pointer", borderRadius:2, letterSpacing:"0.02em", transition:"all 0.08s",
            });
            return (
            <>
              {/* ── Toolbar ── */}
              <div style={{ background:"#fff", border:"1px solid rgba(0,0,0,0.08)", marginBottom:1,
                padding:"8px 12px", display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                {/* Genre select */}
                <select value={drumGenre} onChange={e => setDrumGenre(e.target.value)}
                  style={{ fontFamily:SF, padding:"4px 8px", fontSize:12, fontWeight:500,
                    border:"1px solid rgba(0,0,0,0.12)", background:"#fff", color:t.textPrimary,
                    cursor:"pointer", appearance:"auto", borderRadius:2, minWidth:170 }}>
                  {Object.entries(DRUM_GENRES).map(([k,g]) => (
                    <option key={k} value={k}>{g.label} · {g.bpm}</option>
                  ))}
                </select>

                <div style={{ width:1, height:18, background:"rgba(0,0,0,0.08)" }} />

                {/* Action buttons */}
                <button onClick={generateDrumPattern} style={dawToolBtn(true)}>Generate</button>
                <button onClick={() => { if (drumPattern) { const genre = DRUM_GENRES[drumGenre]; if (genre) { const fresh = genre.generate(); Object.keys(lockedTracks).forEach(tid => { if (lockedTracks[tid] && drumPattern[tid]) fresh[tid] = drumPattern[tid]; }); DRUM_TRACKS.forEach(tr => { if (!fresh[tr.id]) fresh[tr.id] = emptyDrumTrack(); }); setDrumPattern(fresh); }}}}
                  disabled={!drumPattern}
                  style={{ ...dawToolBtn(false), opacity:drumPattern?1:0.35, cursor:drumPattern?"pointer":"default" }}>
                  Variation
                </button>
                <button onClick={playTimeline} disabled={!drumPattern && timelineItems.length===0 && bassLine.length===0}
                  style={{ ...dawToolBtn(true),
                    background: (!drumPattern && timelineItems.length===0 && bassLine.length===0)
                      ? "rgba(0,0,0,0.12)" : looping ? "#E5484D" : t.accent,
                    color: (!drumPattern && timelineItems.length===0 && bassLine.length===0) ? "rgba(0,0,0,0.40)" : "#fff",
                    cursor: (!drumPattern && timelineItems.length===0 && bassLine.length===0) ? "default" : "pointer",
                    minWidth:56 }}>
                  {looping ? "Stop" : "Play"}
                </button>

                <div style={{ width:1, height:18, background:"rgba(0,0,0,0.08)" }} />

                <button onClick={() => setPadMapperOpen(true)} style={dawToolBtn(false)}>Pad Map</button>
                <button onClick={() => { stopLoop(); setDrumPattern(null); setLockedTracks({}); setMutedTracks({}); setSoloTrack(null); }}
                  style={dawToolBtn(false)}>Clear</button>

                <div style={{ width:1, height:18, background:"rgba(0,0,0,0.08)" }} />

                {/* Loop toggle */}
                <button onClick={() => setLoopEnabled(e => !e)}
                  style={{ ...dawToolBtn(false),
                    border:`1px solid ${loopEnabled ? "rgba(48,209,88,0.5)" : "rgba(0,0,0,0.12)"}`,
                    color: loopEnabled ? "#2B9A3E" : "rgba(0,0,0,0.50)",
                    background: loopEnabled ? "rgba(48,209,88,0.08)" : "transparent",
                    fontFamily:MONO, fontSize:10, padding:"3px 8px" }}>
                  {loopEnabled ? "LOOP" : "1×"}
                </button>

                {/* Half-time */}
                <button onClick={() => setDrumHalfTime(h => !h)}
                  style={{ ...dawToolBtn(false),
                    border:`1px solid ${drumHalfTime ? t.accentBorder : "rgba(0,0,0,0.12)"}`,
                    color: drumHalfTime ? t.accent : "rgba(0,0,0,0.50)",
                    background: drumHalfTime ? "rgba(92,124,138,0.08)" : "transparent",
                    fontFamily:MONO, fontSize:10, padding:"3px 8px" }}>
                  ½×
                </button>

                <div style={{ flex:1 }} />

                {/* Parameter readouts */}
                <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                  <span style={{ fontSize:9, fontWeight:700, color:"rgba(0,0,0,0.50)", fontFamily:SF, textTransform:"uppercase", letterSpacing:"0.08em" }}>Density</span>
                  <input type="range" min={0} max={100} value={densityDrums}
                    onChange={e => setDensityDrums(Number(e.target.value))}
                    style={{ width:64, accentColor: densityDrums < 100 ? "#E5930A" : t.accent, height:2 }} />
                  <span style={{ fontSize:10, fontFamily:MONO, color: densityDrums < 100 ? "#E5930A" : "rgba(0,0,0,0.50)", minWidth:28, textAlign:"right" }}>{densityDrums}</span>
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                  <span style={{ fontSize:9, fontWeight:700, color:"rgba(0,0,0,0.50)", fontFamily:SF, textTransform:"uppercase", letterSpacing:"0.08em" }}>Swing</span>
                  <input type="range" min={0} max={100} value={drumSwing}
                    onChange={e => setDrumSwing(Number(e.target.value))}
                    style={{ width:64, accentColor:t.accent, height:2 }} />
                  <span style={{ fontSize:10, fontFamily:MONO, color:"rgba(0,0,0,0.50)", minWidth:28, textAlign:"right" }}>{drumSwing}</span>
                </div>

                {/* Favorites */}
                {drumPattern && (
                  <button onClick={() => {
                    const id = Date.now();
                    const label = `${DRUM_GENRES[drumGenre]?.label || drumGenre} #${drumFavorites.length+1}`;
                    setDrumFavorites(f => [...f, { id, genre:drumGenre, pattern:JSON.parse(JSON.stringify(drumPattern)), label }]);
                  }}
                    style={{ ...dawToolBtn(false), fontSize:10, padding:"3px 8px" }}>
                    Save
                  </button>
                )}
                {drumFavorites.length > 0 && (
                  <select value=""
                    onChange={e => {
                      const fav = drumFavorites.find(f => String(f.id) === e.target.value);
                      if (fav) { stopLoop(); setDrumPattern(JSON.parse(JSON.stringify(fav.pattern))); setDrumGenre(fav.genre); }
                    }}
                    style={{ fontFamily:SF, padding:"3px 6px", fontSize:11, fontWeight:500,
                      border:"1px solid rgba(0,0,0,0.12)", background:"#fff", color:t.textSecondary,
                      cursor:"pointer", borderRadius:2, minWidth:120 }}>
                    <option value="" disabled>Favorites ({drumFavorites.length})</option>
                    {drumFavorites.map(f => (
                      <option key={f.id} value={f.id}>{f.label}</option>
                    ))}
                  </select>
                )}
              </div>

              {/* ── Step Grid ── */}
              {drumPattern && (
                <div style={{ background:"#fff", border:"1px solid rgba(0,0,0,0.08)", overflow:"hidden" }}>
                  {/* Bar header */}
                  <div style={{ display:"grid", gridTemplateColumns:"132px 1fr", borderBottom:"1px solid rgba(0,0,0,0.15)" }}>
                    <div style={{ padding:"3px 8px", background:"rgba(0,0,0,0.02)" }}>
                      <span style={{ fontSize:8, fontWeight:700, color:"rgba(0,0,0,0.40)", letterSpacing:"0.1em", textTransform:"uppercase", fontFamily:SF }}>Track</span>
                    </div>
                    <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)" }}>
                      {Array.from({length:4},(_,i) => (
                        <div key={i} style={{ padding:"3px 4px", borderLeft:`1px solid rgba(0,0,0,${i>0?"0.10":"0"})`, background:"rgba(0,0,0,0.02)" }}>
                          <span style={{ fontSize:8, fontWeight:700, color:"rgba(0,0,0,0.40)", letterSpacing:"0.1em", textTransform:"uppercase", fontFamily:MONO }}>{i+1}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Track rows */}
                  {DRUM_TRACKS.map((track, trackIdx) => {
                    const hasHits = drumPattern[track.id]?.some(v => v > 0);
                    const isMuted = !!mutedTracks[track.id];
                    const isLocked = !!lockedTracks[track.id];
                    const isSolo = soloTrack === track.id;
                    const isTriplet = !!tripletTracks[track.id];
                    const dimmed = soloTrack && !isSolo;
                    const isEvenRow = trackIdx % 2 === 0;
                    return (
                      <div key={track.id} style={{ display:"grid", gridTemplateColumns:"132px 1fr",
                        borderBottom:"1px solid rgba(0,0,0,0.12)", opacity: dimmed ? 0.2 : isMuted ? 0.3 : 1, transition:"opacity 0.1s" }}>
                        {/* Label + controls */}
                        <div style={{ display:"flex", alignItems:"center", gap:1, padding:"0 4px", height:20,
                          background: isEvenRow ? "rgba(0,0,0,0.015)" : "transparent",
                          borderRight:"1px solid rgba(0,0,0,0.08)" }}>
                          <button onClick={() => setLockedTracks(p => ({ ...p, [track.id]: !p[track.id] }))}
                            title={isLocked ? "Unlock" : "Lock"}
                            style={dawBtn(isLocked)}>
                            L
                          </button>
                          <button onClick={() => setMutedTracks(p => ({ ...p, [track.id]: !p[track.id] }))}
                            title={isMuted ? "Unmute" : "Mute"}
                            style={dawBtn(isMuted, "#E5484D")}>
                            M
                          </button>
                          <button onClick={() => setSoloTrack(s => s === track.id ? null : track.id)}
                            title={isSolo ? "Unsolo" : "Solo"}
                            style={dawBtn(isSolo, "#E5930A")}>
                            S
                          </button>
                          {(track.id==="hatC"||track.id==="hatO"||track.id==="ride"||track.id==="shaker") && (
                            <button onClick={() => setTripletTracks(p => ({ ...p, [track.id]: !p[track.id] }))}
                              title={isTriplet ? "16th grid" : "Triplet grid"}
                              style={dawBtn(isTriplet, "#E5930A")}>
                              3
                            </button>
                          )}
                          <span style={{ fontSize:10, fontWeight:600, color: hasHits ? "rgba(0,0,0,0.70)" : "rgba(0,0,0,0.28)",
                            fontFamily:SF, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", flex:1,
                            marginLeft:3, letterSpacing:"0.01em" }}>
                            {track.label}
                          </span>
                        </div>
                        {/* Steps */}
                        <div style={{ display:"grid", gridTemplateColumns:`repeat(${DRUM_STEPS},1fr)`, gap:0,
                          background: isEvenRow ? "rgba(0,0,0,0.015)" : "transparent" }}>
                          {drumPattern[track.id].map((vel, step) => {
                            const isPlayhead = drumStep === step;
                            const isBeatLine = step > 0 && step % 4 === 0;
                            const isBarLine  = step > 0 && step % DRUM_BAR_STEPS === 0;
                            const isOddStep = step % 2 === 1;
                            const swingPx = isOddStep && drumSwing > 0 ? Math.round(drumSwing / 100 * 4) : 0;
                            const densityRemoved = vel > 0 && densityDrums < 100 &&
                              !densityPass(densitySeed, track.id, step, densityDrums, drumImportance(track.id, step));
                            return (
                              <div key={step}
                                onClick={() => toggleDrumStep(track.id, step)}
                                style={{
                                  height:20, position:"relative",
                                  borderLeft: isBarLine ? "1px solid rgba(0,0,0,0.12)" : isBeatLine ? "1px solid rgba(0,0,0,0.12)" : "none",
                                  background: isPlayhead && looping
                                    ? "rgba(92,124,138,0.18)"
                                    : "transparent",
                                  cursor:"pointer",
                                }}>
                                {vel > 0 && (
                                  <div style={{
                                    position:"absolute", top:1, bottom:1, left:swingPx, right: Math.max(0, -swingPx),
                                    background: densityRemoved
                                      ? "transparent"
                                      : `rgba(92,124,138,${Math.min(1, vel/127 * 0.85 + 0.15)})`,
                                    transition:"left 0.1s, right 0.1s",
                                    ...(densityRemoved ? { border:"1px dashed rgba(92,124,138,0.20)" } : {}),
                                  }} />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Empty state */}
              {!drumPattern && (
                <div style={{ background:"#fff", border:"1px solid rgba(0,0,0,0.08)", padding:"40px 20px", textAlign:"center" }}>
                  <p style={{ fontSize:12, color:"rgba(0,0,0,0.45)", fontFamily:SF, margin:0, letterSpacing:"0.02em" }}>
                    Select a genre and press <strong style={{ color:"rgba(0,0,0,0.50)" }}>Generate</strong> to create a drum pattern
                  </p>
                </div>
              )}

              {/* ── Pad Mapper Modal ── */}
              {padMapperOpen && (
                <>
                  <div onClick={() => setPadMapperOpen(false)} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.3)", zIndex:100 }} />
                  <div style={{ position:"fixed", top:"50%", left:"50%", transform:"translate(-50%,-50%)", zIndex:101,
                    width:400, maxHeight:"90vh", overflow:"auto",
                    background:"#fff", border:"1px solid rgba(0,0,0,0.12)", padding:"16px 18px",
                    }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                      <span style={{ fontSize:12, fontWeight:700, color:t.textPrimary, fontFamily:SF, textTransform:"uppercase", letterSpacing:"0.06em" }}>Pad Map</span>
                      <button onClick={() => setPadMapperOpen(false)}
                        style={{ border:"none", background:"none", fontSize:14, cursor:"pointer", color:"rgba(0,0,0,0.50)", fontFamily:SF }}>×</button>
                    </div>

                    {/* Preset selector */}
                    <div style={{ display:"flex", gap:4, flexWrap:"wrap", marginBottom:12 }}>
                      {PAD_MAP_PRESETS.map(preset => {
                        const isActive = DRUM_TRACKS.every(tr => padMap[tr.id]?.midiNote === preset.map[tr.id]?.midiNote);
                        return (
                          <button key={preset.id} onClick={() => setPadMap({...preset.map})}
                            style={{ fontFamily:SF, fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:2,
                              border:`1px solid ${isActive ? "rgba(48,209,88,0.5)" : "rgba(0,0,0,0.15)"}`,
                              background: isActive ? "rgba(48,209,88,0.08)" : "transparent",
                              color: isActive ? "#2B9A3E" : t.textSecondary, cursor:"pointer", transition:"all 0.08s" }}>
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>

                    {/* Sound → Pad list */}
                    <div style={{ display:"flex", flexDirection:"column", gap:1 }}>
                      {DRUM_TRACKS.map((track, i) => {
                        const mapping = padMap[track.id];
                        const currentPadLabel = midiToPadLabel(mapping.midiNote);
                        return (
                          <div key={track.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"3px 6px",
                            background: i % 2 === 0 ? "rgba(0,0,0,0.02)" : "transparent" }}>
                            <span style={{ fontSize:11, fontWeight:600, color:t.accent, fontFamily:SF, width:70, flexShrink:0 }}>{track.label}</span>
                            <span style={{ fontSize:9, color:"rgba(0,0,0,0.20)", fontFamily:MONO }}>→</span>
                            <select value={currentPadLabel}
                              onChange={e => {
                                const midi = padLabelToMidi(e.target.value);
                                setPadMap(p => ({...p, [track.id]: { padId: e.target.value, midiNote: midi }}));
                              }}
                              style={{ fontFamily:MONO, fontSize:12, fontWeight:700,
                                padding:"2px 4px", borderRadius:2, border:"1px solid rgba(0,0,0,0.15)",
                                background:"#fff", color:t.textPrimary, cursor:"pointer", width:60 }}>
                              {MPC_PADS.map(pad => (
                                <option key={pad.label} value={pad.label}>{pad.label}</option>
                              ))}
                            </select>
                            <span style={{ fontSize:9, color:"rgba(0,0,0,0.20)", fontFamily:MONO }}>{mapping.midiNote}</span>
                          </div>
                        );
                      })}
                    </div>

                    <div style={{ marginTop:12, display:"flex", justifyContent:"flex-end" }}>
                      <button onClick={() => setPadMapperOpen(false)}
                        style={{ ...dawToolBtn(true), fontSize:11, padding:"4px 12px" }}>
                        Done
                      </button>
                    </div>
                  </div>
                </>
              )}
            </>
          );})()}

          {/* ════════════════ CHORDS MODE ════════════════ */}
          {mode === "chords" && (
            <>
              <div style={card}>
                {/* ═══ ZONE 1: TRANSPORT ═══ */}
                <div style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 0", borderBottom:`1px solid ${t.border}`, marginBottom:8, flexWrap:"wrap" }}>
                  <button onClick={playTimeline} disabled={timelineItems.length===0 && !drumPattern && bassLine.length===0}
                    style={{ fontFamily:SF, fontSize:11, fontWeight:700, padding:"5px 16px", borderRadius:2, border:"none",
                      background: (timelineItems.length===0 && !drumPattern && bassLine.length===0) ? "rgba(0,0,0,0.12)" : looping ? "#E5484D" : t.accent,
                      color: (timelineItems.length===0 && !drumPattern && bassLine.length===0) ? "rgba(0,0,0,0.40)" : "#fff",
                      cursor: (timelineItems.length===0 && !drumPattern && bassLine.length===0) ? "default" : "pointer",
                      letterSpacing:"0.04em", minWidth:52 }}>
                    {looping ? "STOP" : "PLAY"}
                  </button>

                  <div style={{ width:1, height:22, background:t.border }} />

                  {/* BPM LCD */}
                  <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <span style={{ fontSize:9, fontWeight:700, color:"rgba(0,0,0,0.50)", letterSpacing:"0.08em", fontFamily:SF }}>BPM</span>
                    {!externalBpm && <button onClick={() => setBpm(b => Math.max(40, b-1))} style={{ fontFamily:MONO, fontSize:11, fontWeight:700, width:20, height:22, border:`1px solid ${t.btnBorder}`, background:"transparent", color:"rgba(0,0,0,0.40)", cursor:"pointer", lineHeight:1, borderRadius:1 }}>-</button>}
                    <input type="text" inputMode="numeric" pattern="[0-9]*" value={bpm}
                      readOnly={!!externalBpm}
                      onChange={e => { if (externalBpm) return; const raw = e.target.value.replace(/\D/g,""); if(raw===""){setBpm("");return;} const v=parseInt(raw); if(v>=1&&v<=999) setBpm(v); }}
                      onBlur={e => { if (externalBpm) return; const v=parseInt(e.target.value); setBpm(isNaN(v)?90:Math.min(240,Math.max(40,v))); }}
                      onKeyDown={e => { if (externalBpm) return; if(e.key==="ArrowUp") {e.preventDefault();setBpm(b=>Math.min(240,(parseInt(b)||90)+1));} if(e.key==="ArrowDown") {e.preventDefault();setBpm(b=>Math.max(40,(parseInt(b)||90)-1));} if(e.key==="Enter") e.target.blur(); }}
                      style={{ fontFamily:MONO, fontSize:18, fontWeight:700, textAlign:"center", width:48, padding:"2px 2px", borderRadius:1,
                        border:`1.5px solid ${externalBpm ? "rgba(48,209,88,0.5)" : "rgba(92,124,138,0.30)"}`,
                        background: externalBpm ? "rgba(48,209,88,0.06)" : "rgba(92,124,138,0.04)",
                        color: externalBpm ? "#2B9A3E" : t.accent, outline:"none", letterSpacing:"0.08em", caretColor:t.accent }}
                    />
                    {!externalBpm && <button onClick={() => setBpm(b => Math.min(240, b+1))} style={{ fontFamily:MONO, fontSize:11, fontWeight:700, width:20, height:22, border:`1px solid ${t.btnBorder}`, background:"transparent", color:"rgba(0,0,0,0.40)", cursor:"pointer", lineHeight:1, borderRadius:1 }}>+</button>}
                    {externalBpm && <span style={{ fontSize:8, color:"#2B9A3E", fontFamily:MONO, fontWeight:700 }}>MPC</span>}
                  </div>

                  <div style={{ width:1, height:22, background:t.border }} />

                  {/* Octave */}
                  <div style={{ display:"flex", alignItems:"center", gap:3 }}>
                    <span style={{ fontSize:9, fontWeight:700, color:"rgba(0,0,0,0.50)", letterSpacing:"0.08em", fontFamily:SF }}>OCT</span>
                    <button onClick={() => { if(looping) stopLoop(); setChordOctave(o=>Math.max(2,o-1)); }} style={{ fontFamily:MONO, fontSize:11, fontWeight:700, width:20, height:22, border:`1px solid ${t.btnBorder}`, background:"transparent", color:"rgba(0,0,0,0.40)", cursor:"pointer", lineHeight:1, borderRadius:1 }}>-</button>
                    <span style={{ fontSize:13, fontWeight:700, color:t.textPrimary, fontFamily:MONO, minWidth:14, textAlign:"center" }}>{chordOctave}</span>
                    <button onClick={() => { if(looping) stopLoop(); setChordOctave(o=>Math.min(6,o+1)); }} style={{ fontFamily:MONO, fontSize:11, fontWeight:700, width:20, height:22, border:`1px solid ${t.btnBorder}`, background:"transparent", color:"rgba(0,0,0,0.40)", cursor:"pointer", lineHeight:1, borderRadius:1 }}>+</button>
                  </div>

                  <div style={{ width:1, height:22, background:t.border }} />

                  {/* Loop */}
                  <button onClick={() => setLoopEnabled(e => !e)}
                    style={{ fontFamily:MONO, fontSize:10, fontWeight:700, padding:"3px 8px", borderRadius:2,
                      border:`1px solid ${loopEnabled ? "rgba(48,209,88,0.5)" : "rgba(0,0,0,0.12)"}`,
                      background: loopEnabled ? "rgba(48,209,88,0.08)" : "transparent",
                      color: loopEnabled ? "#2B9A3E" : "rgba(0,0,0,0.50)", cursor:"pointer", letterSpacing:"0.04em" }}>
                    {loopEnabled ? "LOOP" : "1×"}
                  </button>

                  {looping && (
                    <span style={{ fontSize:9, fontWeight:700, color:"#2B9A3E", letterSpacing:"0.06em", fontFamily:MONO,
                      display:"flex", alignItems:"center", gap:4 }}>
                      <span style={{ width:5, height:5, borderRadius:"50%", background:"#2B9A3E", display:"inline-block",
                        animation:"pulse 1.2s ease-in-out infinite" }} />
                      PLAYING
                    </span>
                  )}

                  <div style={{ flex:1 }} />

                  {/* Style dropdown */}
                  <div style={{ position:"relative" }}>
                    <button onClick={() => setStyleMenuOpen(o => !o)}
                      style={{ fontFamily:SF, fontSize:10, fontWeight:600, padding:"4px 10px", borderRadius:2,
                        border:`1px solid ${playStyle!=="normal"?t.accentBorder:"rgba(0,0,0,0.12)"}`,
                        background:playStyle!=="normal"?t.accentBg:"transparent",
                        color:playStyle!=="normal"?t.accent:"rgba(0,0,0,0.50)", cursor:"pointer", display:"flex", alignItems:"center", gap:4 }}>
                      <span style={{ fontSize:8, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.06em", opacity:0.6 }}>Style</span>
                      <span>{STYLES[playStyle].label}</span>
                      <span style={{ fontSize:8, opacity:0.5 }}>▾</span>
                    </button>
                    {styleMenuOpen && (
                      <>
                        <div onClick={() => setStyleMenuOpen(false)} style={{ position:"fixed", inset:0, zIndex:50 }} />
                        <div style={{ position:"absolute", top:"calc(100% + 4px)", right:0, zIndex:51, minWidth:160,
                            background:"#fff", border:`1px solid rgba(0,0,0,0.12)`,
                            padding:2, display:"flex", flexDirection:"column", gap:0 }}>
                          {Object.entries(STYLES).map(([key, cfg]) => (
                            <button key={key} onClick={() => { if(looping) stopLoop(); setPlayStyle(key); setStyleMenuOpen(false); }}
                              style={{ fontFamily:SF, fontSize:11, fontWeight:playStyle===key?700:500,
                                padding:"6px 10px", borderRadius:1, border:"none", textAlign:"left",
                                background:playStyle===key?t.accentBg:"transparent",
                                color:playStyle===key?t.accent:t.textPrimary, cursor:"pointer",
                                display:"flex", justifyContent:"space-between", alignItems:"center", gap:8 }}
                              onMouseEnter={e=>{ if(playStyle!==key) e.currentTarget.style.background=t.elevatedBg; }}
                              onMouseLeave={e=>{ if(playStyle!==key) e.currentTarget.style.background="transparent"; }}>
                              <span>{cfg.label}</span>
                              {playStyle===key && <span style={{ fontSize:10 }}>✓</span>}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* ═══ ZONE 2: MIXER ═══ */}
                <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center", padding:"6px 0", borderBottom:`1px solid ${t.border}`, marginBottom:8 }}>
                  <span style={{ fontSize:8, fontWeight:700, color:"rgba(0,0,0,0.40)", letterSpacing:"0.10em", textTransform:"uppercase", fontFamily:SF, marginRight:2 }}>MIX</span>
                  {[
                    { key:"chords", label:"CHD", muted:muteChords, setMute:setMuteChords, disabled:false, density:densityChords, setDensity:setDensityChords },
                    { key:"bass",   label:"BAS", muted:muteBass,   setMute:setMuteBass,   disabled:bassLine.length===0, density:densityBass, setDensity:setDensityBass },
                    { key:"melody", label:"MEL", muted:muteMelody, setMute:setMuteMelody, disabled:melodyLine.length===0, density:densityMelody, setDensity:setDensityMelody },
                    { key:"drums",  label:"DRM", muted:muteDrums,  setMute:setMuteDrums,  disabled:!drumPattern, density:densityDrums, setDensity:setDensityDrums },
                  ].map(({ key, label, muted, setMute, disabled, density, setDensity }) => {
                    const soloThis = () => {
                      const others = { chords:muteChords, bass:muteBass, melody:muteMelody, drums:muteDrums };
                      delete others[key];
                      const isSolo = !muted && Object.values(others).every(m => m);
                      if (isSolo) {
                        setMuteChords(false); setMuteBass(false); setMuteMelody(false); setMuteDrums(false);
                      } else {
                        setMuteChords(key!=="chords"); setMuteBass(key!=="bass");
                        setMuteMelody(key!=="melody"); setMuteDrums(key!=="drums");
                      }
                    };
                    const others2 = { chords:muteChords, bass:muteBass, melody:muteMelody, drums:muteDrums };
                    delete others2[key];
                    const isSolod = !muted && Object.values(others2).every(m => m);
                    const densActive = density < 100;
                    return (
                      <div key={key} style={{ display:"flex", alignItems:"center", gap:2, padding:"2px 4px 2px 0",
                        borderRight:`1px solid ${t.border}`, marginRight:2 }}>
                        <button onClick={e => e.shiftKey ? soloThis() : setMute(m => !m)}
                          style={{ fontFamily:MONO, fontSize:9, fontWeight:700, padding:"2px 5px", borderRadius:1,
                            border:`1px solid ${muted ? "#E5484D" : isSolod ? "#E5930A" : "rgba(0,0,0,0.15)"}`,
                            background: muted ? "rgba(229,72,77,0.08)" : isSolod ? "rgba(229,147,10,0.08)" : "transparent",
                            color: muted ? "#E5484D" : isSolod ? "#E5930A" : disabled ? "rgba(0,0,0,0.20)" : "rgba(0,0,0,0.55)",
                            cursor: disabled && !muted ? "default" : "pointer",
                            textDecoration: muted ? "line-through" : "none",
                            opacity: disabled && !muted ? 0.35 : 1, letterSpacing:"0.04em" }}>
                          {label}
                        </button>
                        <button onClick={soloThis} title={`Solo ${key}`}
                          style={{ fontFamily:MONO, fontSize:8, fontWeight:700, padding:"2px 3px", borderRadius:1,
                            border:`1px solid ${isSolod ? "#E5930A" : "rgba(0,0,0,0.15)"}`,
                            background: isSolod ? "rgba(229,147,10,0.08)" : "transparent",
                            color: isSolod ? "#E5930A" : "rgba(0,0,0,0.40)", cursor:"pointer" }}>
                          S
                        </button>
                        <input type="range" min={0} max={100} value={density}
                          onChange={e => setDensity(Number(e.target.value))}
                          title={`${key} density: ${density}%`}
                          style={{ width:56, height:14, accentColor: densActive ? "#E5930A" : "rgba(0,0,0,0.20)", cursor:"pointer" }} />
                        <span style={{ fontSize:9, fontFamily:MONO, color: densActive ? "#E5930A" : "rgba(0,0,0,0.20)", minWidth:22, textAlign:"right" }}>{density}</span>
                      </div>
                    );
                  })}
                </div>

                {/* ═══ ZONE 3: PERFORMANCE ═══ */}
                <div style={{ display:"flex", gap:10, flexWrap:"wrap", alignItems:"center", padding:"6px 0", borderBottom:`1px solid ${t.border}`, marginBottom:8 }}>
                  {/* Energy — blue accent */}
                  <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <span style={{ fontSize:9, fontWeight:700, color: energy !== 75 ? "#3B82F6" : "rgba(0,0,0,0.50)", letterSpacing:"0.08em", textTransform:"uppercase", fontFamily:SF }}>Energy</span>
                    <input type="range" min={0} max={100} value={energy}
                      onChange={e => { const v = +e.target.value; setEnergy(v); energyRef.current = v; }}
                      style={{ width:100, accentColor: energy !== 75 ? "#3B82F6" : "rgba(0,0,0,0.20)", cursor:"pointer" }} />
                    <span style={{ fontSize:10, fontFamily:MONO, color: energy !== 75 ? "#3B82F6" : "rgba(0,0,0,0.40)", minWidth:22, textAlign:"right" }}>{energy}</span>
                  </div>
                  {/* Variation — orange accent */}
                  <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <span style={{ fontSize:9, fontWeight:700, color: variationAmount > 0 ? "#E5930A" : "rgba(0,0,0,0.50)", letterSpacing:"0.08em", textTransform:"uppercase", fontFamily:SF }}>Variation</span>
                    <input type="range" min={0} max={100} value={variationAmount}
                      onChange={e => { const v = +e.target.value; setVariationAmount(v); variationAmountRef.current = v; }}
                      style={{ width:100, accentColor: variationAmount > 0 ? "#E5930A" : "rgba(0,0,0,0.20)", cursor:"pointer" }} />
                    <span style={{ fontSize:10, fontFamily:MONO, color: variationAmount > 0 ? "#E5930A" : "rgba(0,0,0,0.40)", minWidth:22, textAlign:"right" }}>{variationAmount}</span>
                  </div>
                  {/* Feel — neutral accent */}
                  <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <span style={{ fontSize:9, fontWeight:700, color: humanize > 0 ? "#6B6B6B" : "rgba(0,0,0,0.50)", letterSpacing:"0.08em", textTransform:"uppercase", fontFamily:SF }}>Feel</span>
                    <input type="range" min={0} max={100} value={humanize}
                      onChange={e => setHumanize(Number(e.target.value))}
                      style={{ width:100, accentColor: humanize > 0 ? "#6B6B6B" : "rgba(0,0,0,0.20)", cursor:"pointer" }} />
                    <span style={{ fontSize:10, fontFamily:MONO, color: humanize > 0 ? "#6B6B6B" : "rgba(0,0,0,0.40)", minWidth:22, textAlign:"right" }}>{humanize}</span>
                  </div>

                  <div style={{ width:1, height:18, background:t.border }} />

                  {/* Fill — green accent */}
                  <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <span style={{ fontSize:9, fontWeight:700, color:"rgba(0,0,0,0.50)", letterSpacing:"0.08em", textTransform:"uppercase", fontFamily:SF }}>Fill</span>
                    <button onClick={() => { fillNextRef.current = true; }}
                      disabled={!drumPattern || !looping}
                      style={{ fontFamily:MONO, fontSize:9, fontWeight:700, padding:"2px 6px", borderRadius:1,
                        border:`1px solid ${fillNextRef.current ? "#2B9A3E" : "rgba(0,0,0,0.15)"}`,
                        background: fillNextRef.current ? "rgba(43,154,62,0.08)" : "transparent",
                        color: fillNextRef.current ? "#2B9A3E" : "rgba(0,0,0,0.50)",
                        cursor: (!drumPattern || !looping) ? "default" : "pointer",
                        opacity: (!drumPattern || !looping) ? 0.35 : 1, letterSpacing:"0.04em" }}>
                      NEXT
                    </button>
                    <select value={fillMode} onChange={e => { setFillMode(e.target.value); fillModeRef.current = e.target.value; }}
                      style={{ fontFamily:SF, fontSize:10, padding:"2px 4px", borderRadius:2,
                        border:"1px solid rgba(0,0,0,0.15)", background:"transparent", color:"rgba(0,0,0,0.50)" }}>
                      <option value="off">Off</option>
                      <option value="auto4">4 loops</option>
                      <option value="auto8">8 loops</option>
                    </select>
                  </div>

                  <div style={{ width:1, height:18, background:t.border }} />

                  {/* Arp */}
                  <button onClick={() => { if(looping) stopLoop(); setArpOn(a=>!a); }}
                    style={{ fontFamily:MONO, fontSize:9, fontWeight:700, padding:"2px 6px", borderRadius:1,
                      border:`1px solid ${arpOn?t.accentBorder:"rgba(0,0,0,0.15)"}`, background:arpOn?"rgba(92,124,138,0.08)":"transparent",
                      color:arpOn?t.accent:"rgba(0,0,0,0.50)", cursor:"pointer", letterSpacing:"0.04em" }}>
                    ARP
                  </button>
                  {arpOn && <>
                    {[{v:"up",l:"↑"},{v:"down",l:"↓"},{v:"updown",l:"↑↓"},{v:"random",l:"?"}].map(({v,l}) => (
                      <button key={v} onClick={() => { if(looping) stopLoop(); setArpPattern(v); }}
                        style={{ fontFamily:MONO, fontSize:10, fontWeight:700, padding:"2px 5px", borderRadius:1,
                          border:`1px solid ${arpPattern===v?t.accentBorder:"rgba(0,0,0,0.15)"}`, background:arpPattern===v?"rgba(92,124,138,0.08)":"transparent",
                          color:arpPattern===v?t.accent:"rgba(0,0,0,0.45)", cursor:"pointer" }}>{l}</button>
                    ))}
                    <div style={{ width:1, height:14, background:t.border }} />
                    {[{v:0.25,l:"16th"},{v:0.5,l:"8th"},{v:1,l:"¼"}].map(({v,l}) => (
                      <button key={v} onClick={() => { if(looping) stopLoop(); setArpRate(v); }}
                        style={{ fontFamily:MONO, fontSize:9, fontWeight:700, padding:"2px 5px", borderRadius:1,
                          border:`1px solid ${arpRate===v?t.accentBorder:"rgba(0,0,0,0.15)"}`, background:arpRate===v?"rgba(92,124,138,0.08)":"transparent",
                          color:arpRate===v?t.accent:"rgba(0,0,0,0.45)", cursor:"pointer" }}>{l}</button>
                    ))}
                  </>}
                </div>
              </div>
              {/* Chord grid */}
              <div style={card}>
                <div style={{ ...labelStyle, marginBottom:14 }}>Scale chords</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:8 }}>
                  {chords.map((c, i) => {
                    const isActive  = activeChord  && activeChord.noteIdx===c.noteIdx  && activeChord.quality===c.quality;
                    const isHovered = hoveredChord && hoveredChord.noteIdx===c.noteIdx && hoveredChord.quality===c.quality;
                    const accent = isActive || isHovered;
                    return (
                      <div key={i}
                        onClick={() => addChord(c)}
                        onMouseEnter={() => {
                          setHoveredChord(c);
                          if (!looping) {
                            const names = getChordNoteNames(c.noteIdx, c.quality, chordOctave);
                            playChord(names, soundType);
                          }
                        }}
                        onMouseLeave={() => setHoveredChord(null)}
                        style={{
                          border: accent ? `1px solid rgba(92,124,138,0.50)` : `1px solid rgba(0,0,0,0.08)`,
                          borderRadius:2, padding:"10px 6px 8px",
                          background: isActive ? "rgba(92,124,138,0.08)" : isHovered ? "#FAFAFA" : "#FFFFFF",
                          cursor:"pointer", textAlign:"center", userSelect:"none",
                          transition:"all 0.08s",
                        }}>
                        <div style={{ fontSize:10, color:accent?t.accent:t.textTertiary, marginBottom:4, fontWeight:700, letterSpacing:"0.12em", textTransform:"uppercase" }}>
                          {c.degree}
                        </div>
                        <div style={{ fontSize:15, fontWeight:700, color:accent?t.accent:t.chordNameColor, letterSpacing:"0.03em" }}>
                          {c.display}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Piano */}
              <div style={card}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
                  <div style={labelStyle}>Piano</div>
                  <div style={{ fontSize:12, color:t.textSecondary, fontWeight:400 }}>
                    {displayChord
                      ? <span><span style={{ color:t.accent, fontWeight:600 }}>{displayChord.display}</span> · click a key to play single notes</span>
                      : "hover over a chord to see notes"}
                  </div>
                </div>

                <div style={{ display:"flex", gap:6, alignItems:"center", height:44, marginBottom:14, flexWrap:"nowrap" }}>
                  {displayChord
                    ? getChordNoteIndices(displayChord.noteIdx, displayChord.quality).map((ni, i) => (
                        <span key={i} style={{
                          background:t.accentBg, color:t.accent, border:`1px solid ${t.accentBorder}`,
                          borderRadius:2, padding:"4px 12px", fontSize:13, fontWeight:600,
                          letterSpacing:"-0.01em", fontFamily:SF,
                        }}>
                          {NOTES[ni]}
                        </span>
                      ))
                    : <span style={{ fontSize:13, color:t.textTertiary, fontFamily:SF }}>Hover over a chord to see notes</span>
                  }
                </div>

                <div style={{ background:t.pianoRailBg, borderRadius:2, padding:"10px 12px 12px", boxShadow:t.pianoRailShadow }}>
                  <div style={{ background:t.pianoKeysBg, borderRadius:2, overflow:"hidden" }}>
                    <Piano highlightedNotes={highlightedNotes} scaleNoteIndices={scaleNoteIndices} t={t} onNoteClick={note => { if (!sendMIDISingleNote(note)) playSingleNote(note, soundType); }} />
                  </div>
                </div>

                <div style={{ display:"flex", gap:16, marginTop:12, fontSize:12, color:t.textSecondary }}>
                  <span style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ width:14, height:14, borderRadius:2, background:t.legendChord, display:"inline-block", flexShrink:0 }} />
                    Chord tones
                  </span>
                  <span style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ width:14, height:14, borderRadius:2, background:t.legendScale, border:`1px solid ${t.legendScaleBdr}`, display:"inline-block", flexShrink:0 }} />
                    Scale tones
                  </span>
                </div>
              </div>

              {/* ── Timeline ── */}
              <div style={card}>
                {/* Header row */}
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12, flexWrap:"wrap", gap:8 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <div style={labelStyle}>Timeline — 4 bars</div>
                    {looping && (
                      <span style={{ fontSize:11, fontWeight:600, color:"#30D158", letterSpacing:"0.05em",
                        display:"flex", alignItems:"center", gap:5 }}>
                        <span style={{ width:7, height:7, borderRadius:"50%", background:"#30D158",
                          display:"inline-block",
                          animation:"pulse 1.2s ease-in-out infinite" }} />
                        LOOPING
                      </span>
                    )}
                  </div>
                  <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
                    {/* BPM */}
                    <span style={{ fontSize:11, fontWeight:600, color: externalBpm ? "#30D158" : t.labelColor, textTransform:"uppercase", letterSpacing:"0.07em" }}>
                      {externalBpm ? "BPM ← MPC" : "BPM"}
                    </span>
                    {clockDebug && midiSyncMode === "receive" && (
                      <span style={{ fontSize:8, color:t.textTertiary, fontFamily:MONO, opacity:0.7 }}>{clockDebug}</span>
                    )}
                    {!externalBpm && <button onClick={() => setBpm(b => Math.max(40, b-1))} style={{ fontFamily:SF, fontSize:13, fontWeight:600, width:26, height:26, borderRadius:2, border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer", lineHeight:1 }}>−</button>}
                    <input type="text" inputMode="numeric" pattern="[0-9]*" value={bpm}
                      readOnly={!!externalBpm}
                      onChange={e => { if (externalBpm) return; const raw = e.target.value.replace(/\D/g,""); if(raw===""){setBpm("");return;} const v=parseInt(raw); if(v>=1&&v<=999) setBpm(v); }}
                      onBlur={e => { if (externalBpm) return; const v=parseInt(e.target.value); setBpm(isNaN(v)?90:Math.min(240,Math.max(40,v))); }}
                      onKeyDown={e => { if (externalBpm) return; if(e.key==="ArrowUp") {e.preventDefault();setBpm(b=>Math.min(240,(parseInt(b)||90)+1));} if(e.key==="ArrowDown") {e.preventDefault();setBpm(b=>Math.max(40,(parseInt(b)||90)-1));} if(e.key==="Enter") e.target.blur(); }}
                      style={{ fontFamily:MONO, fontSize:17, fontWeight:700, textAlign:"center", width:54, padding:"4px 4px", borderRadius:2,
                        border:`1.5px solid ${externalBpm ? "rgba(48,209,88,0.5)" : "rgba(92,124,138,0.35)"}`,
                        background: externalBpm ? "rgba(48,209,88,0.08)" : t.inputBg,
                        color: externalBpm ? "#30D158" : t.accent, outline:"none", letterSpacing:"0.08em", caretColor:t.accent,
                        cursor: externalBpm ? "default" : "text" }}
                    />
                    {!externalBpm && <button onClick={() => setBpm(b => Math.min(240, b+1))} style={{ fontFamily:SF, fontSize:13, fontWeight:600, width:26, height:26, borderRadius:2, border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer", lineHeight:1 }}>+</button>}
                    <div style={{ width:1, height:20, background:t.border, margin:"0 2px" }} />
                    {/* Octave */}
                    <span style={{ fontSize:11, fontWeight:600, color:t.labelColor, textTransform:"uppercase", letterSpacing:"0.07em" }}>Oct</span>
                    <button onClick={() => { if(looping) stopLoop(); setChordOctave(o=>Math.max(2,o-1)); }} style={{ fontFamily:SF, fontSize:13, fontWeight:600, width:26, height:26, borderRadius:2, border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer", lineHeight:1 }}>−</button>
                    <span style={{ fontSize:14, fontWeight:700, color:t.textPrimary, minWidth:16, textAlign:"center" }}>{chordOctave}</span>
                    <button onClick={() => { if(looping) stopLoop(); setChordOctave(o=>Math.min(6,o+1)); }} style={{ fontFamily:SF, fontSize:13, fontWeight:600, width:26, height:26, borderRadius:2, border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer", lineHeight:1 }}>+</button>
                  </div>
                </div>

                {/* Timeline track */}
                <div style={{ borderRadius:2, overflow:"hidden", border:`1px solid ${t.border}`, marginBottom:12 }}>
                  {/* Bar labels */}
                  <div style={{ display:"grid", gridTemplateColumns:`repeat(4,1fr)`, background:t.elevatedBg, borderBottom:`1px solid ${t.border}` }}>
                    {Array.from({length:4}, (_,i) => (
                      <div key={i} style={{ padding:"4px 6px", borderLeft: i>0 ? `1px solid ${t.border}` : "none" }}>
                        <span style={{ fontSize:9, fontWeight:700, color:t.textTertiary, letterSpacing:"0.08em", textTransform:"uppercase" }}>Bar {i+1}</span>
                      </div>
                    ))}
                  </div>
                  {/* Track area */}
                  <div ref={trackRef} style={{ position:"relative", height:76, background:t.slotBg, userSelect:"none" }}>
                    {/* Slot lines — bar (prominent), half-bar (medium), beat (faint) */}
                    {Array.from({length:TIMELINE_SLOTS}, (_,i) => {
                      if (i===0) return null;
                      let bg;
                      if (i%SLOTS_PER_BAR===0)            bg = t.border;                // bar
                      else if (i%(SLOTS_PER_BAR/2)===0)   bg = "rgba(0,0,0,0.09)";   // half-bar
                      else if (i%(SLOTS_PER_BAR/4)===0)   bg = "rgba(0,0,0,0.04)";   // beat
                      else                                return null;                  // skip eighth/sixteenth
                      return <div key={i} style={{ position:"absolute", left:`${i/TIMELINE_SLOTS*100}%`, top:0, bottom:0, width:1, background:bg, pointerEvents:"none" }} />;
                    })}
                    {/* Chord blocks */}
                    {timelineItems.map(item => {
                      const cpat = CHORD_PLAY_PATTERNS[chordPlayPattern] || CHORD_PLAY_PATTERNS.sustained;
                      const hits = cpat.generate(item.lengthSlots);
                      const isSustained = chordPlayPattern === "sustained";
                      const itemMutes = chordRhythmMutes[item.id] || {};

                      return (
                      <div key={item.id}
                        onMouseDown={e => { if(e.target.dataset.resize || e.target.dataset.rhythmhit) return; e.preventDefault(); dragRef.current={type:"move",id:item.id,startX:e.clientX,origStart:item.startSlot,origLength:item.lengthSlots}; }}
                        onDoubleClick={e => {
                          if (e.target.dataset.rhythmhit) return;
                          e.preventDefault(); e.stopPropagation();
                          dragRef.current = null;
                          setTimelineItems(prev => {
                            const origEnd = item.startSlot + item.lengthSlots;
                            const maxLen = Math.min(item.lengthSlots, TIMELINE_SLOTS - origEnd);
                            if (maxLen < 1) return prev;
                            if (isSlotFree(prev, origEnd, maxLen)) {
                              return [...prev, { id: Date.now()+Math.random(), chord: item.chord, startSlot: origEnd, lengthSlots: maxLen }];
                            }
                            return prev;
                          });
                        }}
                        style={{
                          position:"absolute",
                          left:`${(item.startSlot/TIMELINE_SLOTS)*100}%`,
                          width:`calc(${(item.lengthSlots/TIMELINE_SLOTS)*100}% - 4px)`,
                          top:6, height:"calc(100% - 12px)",
                          background: isSustained ? t.accentCardBg : "transparent",
                          border: isSustained ? `1px solid ${t.accentBorder}` : "none",
                          borderRadius:2, cursor:"grab",
                          overflow:"hidden",
                          boxShadow: "none",
                        }}>
                        {/* Sustained mode — original look */}
                        {isSustained && (
                          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", width:"100%", height:"100%", padding:"0 4px 0 8px" }}>
                            <span style={{ fontSize:13, fontWeight:700, color:t.accent, fontFamily:SF, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", letterSpacing:"0.02em" }}>
                              {item.chord.display}
                            </span>
                            <div style={{ display:"flex", alignItems:"center", gap:2, flexShrink:0 }}>
                              <button onClick={() => { stopLoop(); setTimelineItems(p => p.filter(it=>it.id!==item.id)); }}
                                style={{ background:"none", border:"none", color:t.textTertiary, cursor:"pointer", fontSize:14, padding:"0 3px", lineHeight:1, fontFamily:SF }}>×</button>
                              <div data-resize="1"
                                onMouseDown={e => { e.preventDefault(); e.stopPropagation(); dragRef.current={type:"resize",id:item.id,startX:e.clientX,origStart:item.startSlot,origLength:item.lengthSlots}; }}
                                style={{ width:6, height:24, borderRadius:2, background:"rgba(255,255,255,0.15)", cursor:"ew-resize", flexShrink:0 }} />
                            </div>
                          </div>
                        )}
                        {/* Rhythm pattern mode — show hits as sub-blocks */}
                        {!isSustained && (
                          <div style={{ position:"relative", width:"100%", height:"100%" }}>
                            {/* Chord label floating top-left */}
                            <span style={{ position:"absolute", top:1, left:4, fontSize:9, fontWeight:700, color:t.accent, fontFamily:SF, opacity:0.7, zIndex:2, pointerEvents:"none" }}>
                              {item.chord.display}
                            </span>
                            {/* Hit sub-blocks */}
                            {hits.map((hit, hIdx) => {
                              const isMuted = !!itemMutes[hIdx];
                              const leftPct = hit.offset * 100;
                              const widthPct = Math.max(hit.duration * 100, 2); // min 2% so it's visible
                              return (
                                <div key={hIdx}
                                  data-rhythmhit="1"
                                  onClick={e => {
                                    e.stopPropagation();
                                    setChordRhythmMutes(prev => {
                                      const cur = prev[item.id] || {};
                                      const next = { ...cur };
                                      if (next[hIdx]) delete next[hIdx];
                                      else next[hIdx] = true;
                                      return { ...prev, [item.id]: next };
                                    });
                                  }}
                                  title={isMuted ? `Hit ${hIdx+1} — muted (click to unmute)` : `Hit ${hIdx+1} — vel ${Math.round(hit.velMult*100)}% (click to mute)`}
                                  style={{
                                    position:"absolute",
                                    left:`${leftPct}%`,
                                    width:`${widthPct}%`,
                                    top:2, bottom:2,
                                    background: isMuted
                                      ? "rgba(128,128,128,0.15)"
                                      : `rgba(92,124,138,${0.25 + hit.velMult * 0.45})`,
                                    border: isMuted
                                      ? "1px dashed rgba(128,128,128,0.3)"
                                      : `1px solid rgba(92,124,138,${0.3 + hit.velMult * 0.3})`,
                                    borderRadius:2,
                                    cursor:"pointer",
                                    transition:"all 0.1s",
                                    boxShadow: "none",
                                  }}
                                />
                              );
                            })}
                            {/* Controls: delete + resize handle */}
                            <div style={{ position:"absolute", top:0, right:0, bottom:0, display:"flex", alignItems:"center", gap:1, zIndex:3 }}>
                              <button onClick={() => { stopLoop(); setTimelineItems(p => p.filter(it=>it.id!==item.id)); }}
                                style={{ background:"none", border:"none", color:t.textTertiary, cursor:"pointer", fontSize:12, padding:"0 2px", lineHeight:1, fontFamily:SF }}>×</button>
                              <div data-resize="1"
                                onMouseDown={e => { e.preventDefault(); e.stopPropagation(); dragRef.current={type:"resize",id:item.id,startX:e.clientX,origStart:item.startSlot,origLength:item.lengthSlots}; }}
                                style={{ width:5, height:20, borderRadius:2, background:"rgba(92,124,138,0.2)", cursor:"ew-resize", flexShrink:0 }} />
                            </div>
                          </div>
                        )}
                      </div>
                    );})}

                    {/* Playhead */}
                    {looping && (
                      <div style={{ position:"absolute", left:`${playheadPct*100}%`, top:0, bottom:0, width:2, background:t.accent, opacity:0.9, pointerEvents:"none" }} />
                    )}
                    {/* Empty state */}
                    {timelineItems.length===0 && (
                      <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                        <span style={{ fontSize:13, color:t.textTertiary, fontFamily:SF }}>Click a chord above to add it to the timeline ↑</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Loop toggle — right below timeline */}
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
                  <button onClick={() => setLoopEnabled(e => !e)}
                    style={{ fontFamily:MONO, fontSize:10, fontWeight:700, padding:"3px 8px", borderRadius:2,
                      border:`1px solid ${loopEnabled ? "rgba(48,209,88,0.5)" : t.btnBorder}`,
                      background: loopEnabled ? "rgba(48,209,88,0.08)" : "transparent",
                      color: loopEnabled ? "#2B9A3E" : "rgba(0,0,0,0.50)",
                      cursor:"pointer", transition:"all 0.08s", letterSpacing:"0.04em" }}>
                    {loopEnabled ? "LOOP" : "1×"}
                  </button>
                  {!loopEnabled && (
                    <span style={{ fontSize:10, color:t.textTertiary, fontFamily:SF }}>Stops after one pass</span>
                  )}
                </div>

                {/* ── Chord Pattern ── */}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:4 }}>
                    <span style={{ fontFamily:SF, fontSize:11, fontWeight:600, color:t.labelColor, letterSpacing:"0.06em", textTransform:"uppercase", opacity:0.8 }}>
                      Chord Rhythm
                    </span>
                    <select value={chordPlayPattern}
                      onChange={e => { if(looping) stopLoop(); setChordPlayPattern(e.target.value); setChordRhythmMutes({}); }}
                      style={{ fontFamily:SF, fontSize:11, fontWeight:600, padding:"5px 10px", borderRadius:2,
                        border:`1px solid ${t.inputBorder}`, background:t.inputBg, color:t.textPrimary, cursor:"pointer" }}>
                      {Object.entries(CHORD_PLAY_PATTERNS).map(([key, cfg]) => (
                        <option key={key} value={key}>{cfg.label} — {cfg.desc}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* ── Piano Roll ── */}
                <div style={{ marginBottom: 12 }}>
                  <button onClick={() => setPianoRollOpen(o => !o)}
                    style={{ fontFamily:SF, fontSize:11, fontWeight:600, color:t.labelColor, background:"none", border:"none",
                      cursor:"pointer", padding:"4px 0", letterSpacing:"0.06em", textTransform:"uppercase",
                      display:"flex", alignItems:"center", gap:6, opacity:0.8 }}>
                    <span style={{ fontSize:8, transition:"transform 0.2s", transform: pianoRollOpen ? "rotate(90deg)" : "rotate(0)" }}>▶</span>
                    Piano Roll {pianoRollNotes.length > 0 ? `(${pianoRollNotes.length} notes)` : ""}
                  </button>
                  {pianoRollOpen && (() => {
                    const range = getPianoRollRange();
                    const noteCount = range.high - range.low;
                    const ROW_H = 16;
                    const LABEL_W = 42;
                    const VEL_STEPS = [40, 70, 100, 127]; // pp mp mf ff
                    const VEL_LABELS = ["pp","mp","mf","ff"];
                    const isBlack = (midi) => [1,3,6,8,10].includes(midi % 12);
                    const midiToName = (midi) => NOTES[midi % 12] + Math.floor((midi - 12) / 12);

                    return (
                      <div ref={pianoRollRef} style={{ display:"flex", borderRadius:2, overflow:"hidden", border:`1px solid ${t.border}`, marginTop:4 }}>
                        {/* Note labels (left) */}
                        <div style={{ width:LABEL_W, flexShrink:0, background:t.elevatedBg, borderRight:`1px solid ${t.border}` }}>
                          {Array.from({length:noteCount}, (_,i) => {
                            const midi = range.high - 1 - i;
                            const black = isBlack(midi);
                            const isC = midi % 12 === 0;
                            return (
                              <div key={midi} style={{
                                height:ROW_H, display:"flex", alignItems:"center", justifyContent:"flex-end",
                                paddingRight:6, boxSizing:"border-box",
                                borderBottom: isC ? `1px solid ${t.border}` : `1px solid rgba(0,0,0,0.03)`,
                                background: black ? "rgba(0,0,0,0.04)" : "transparent",
                              }}>
                                <span style={{
                                  fontSize: 8.5, fontFamily:"'SF Pro Text',-apple-system,sans-serif",
                                  fontWeight: isC ? 700 : 450,
                                  color: isC ? t.textPrimary : black ? t.textTertiary : t.textSecondary,
                                }}>{midiToName(midi)}</span>
                              </div>
                            );
                          })}
                        </div>
                        {/* Grid area */}
                        <div style={{ flex:1, position:"relative", overflow:"hidden" }}>
                          {/* Background rows */}
                          {Array.from({length:noteCount}, (_,i) => {
                            const midi = range.high - 1 - i;
                            const black = isBlack(midi);
                            const isC = midi % 12 === 0;
                            return (
                              <div key={midi} style={{
                                height:ROW_H,
                                background: black ? "rgba(0,0,0,0.025)" : i % 2 === 0 ? "rgba(0,0,0,0.008)" : "transparent",
                                borderBottom: isC ? `1px solid rgba(0,0,0,0.08)` : `1px solid rgba(0,0,0,0.02)`,
                              }} />
                            );
                          })}
                          {/* Vertical slot lines */}
                          {Array.from({length:TIMELINE_SLOTS}, (_,i) => {
                            if (i === 0) return null;
                            let bg;
                            if (i % SLOTS_PER_BAR === 0) bg = "rgba(0,0,0,0.12)";
                            else if (i % (SLOTS_PER_BAR/2) === 0) bg = "rgba(0,0,0,0.12)";
                            else if (i % (SLOTS_PER_BAR/4) === 0) bg = "rgba(0,0,0,0.03)";
                            else return null;
                            return <div key={i} style={{ position:"absolute", left:`${i/TIMELINE_SLOTS*100}%`, top:0, bottom:0, width:1, background:bg, pointerEvents:"none" }} />;
                          })}
                          {/* Note blocks */}
                          {pianoRollNotes.filter(n => !n.muted).map((note, noteIdx) => {
                            const row = range.high - 1 - note.midiNum;
                            if (row < 0 || row >= noteCount) return null;
                            const velIdx = VEL_STEPS.findIndex(v => note.velocity <= v);
                            const velOpacity = 0.4 + (velIdx >= 0 ? velIdx : 3) * 0.18;
                            // Density: find this note's index within its chord for deterministic hash
                            const sameChordNotes = pianoRollNotes.filter(n => n.chordId === note.chordId && !n.muted);
                            const idxInChord = sameChordNotes.findIndex(n => n.key === note.key);
                            const densRemoved = densityChords < 100 && idxInChord > 0 &&
                              !densityPass(densitySeed, "chord", note.startSlot * 100 + idxInChord, densityChords, chordNoteImportance(idxInChord, sameChordNotes.length));
                            return (
                              <div key={note.key}
                                onClick={() => {
                                  const curIdx = VEL_STEPS.findIndex(v => note.velocity <= v);
                                  const nextIdx = (curIdx + 1) % VEL_STEPS.length;
                                  setPianoRollEdits(prev => ({
                                    ...prev,
                                    [note.key]: { ...(prev[note.key] || {}), velocity: VEL_STEPS[nextIdx] }
                                  }));
                                }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setPianoRollEdits(prev => ({
                                    ...prev,
                                    [note.key]: { ...(prev[note.key] || {}), muted: true }
                                  }));
                                }}
                                title={`${note.noteName} vel:${note.velocity} (${VEL_LABELS[velIdx >= 0 ? velIdx : 3]})${densRemoved?" (density removed)":""} — click to cycle, right-click to mute`}
                                style={{
                                  position:"absolute",
                                  top: row * ROW_H + 1,
                                  left: `${(note.startSlot / TIMELINE_SLOTS) * 100}%`,
                                  width: `calc(${(note.lengthSlots / TIMELINE_SLOTS) * 100}% - 2px)`,
                                  height: ROW_H - 2,
                                  background: densRemoved
                                    ? `rgba(92,124,138,0.1)`
                                    : `rgba(92,124,138,${velOpacity})`,
                                  borderRadius: 3,
                                  cursor: "pointer",
                                  border: densRemoved ? "1px dashed rgba(92,124,138,0.25)" : "1px solid rgba(92,124,138,0.5)",
                                  transition: "background 0.2s, border 0.2s",
                                  display:"flex", alignItems:"center", paddingLeft:3,
                                  overflow:"hidden",
                                }}>
                                <span style={{ fontSize:7.5, color: densRemoved ? "rgba(92,124,138,0.3)" : "#fff", fontWeight:600, fontFamily:SF, opacity:0.9, whiteSpace:"nowrap" }}>
                                  {note.noteName}
                                </span>
                              </div>
                            );
                          })}
                          {/* Muted notes (dimmed) */}
                          {pianoRollNotes.filter(n => n.muted).map(note => {
                            const row = range.high - 1 - note.midiNum;
                            if (row < 0 || row >= noteCount) return null;
                            return (
                              <div key={note.key}
                                onClick={() => {
                                  setPianoRollEdits(prev => ({
                                    ...prev,
                                    [note.key]: { ...(prev[note.key] || {}), muted: false }
                                  }));
                                }}
                                title={`${note.noteName} (muted) — click to unmute`}
                                style={{
                                  position:"absolute",
                                  top: row * ROW_H + 1,
                                  left: `${(note.startSlot / TIMELINE_SLOTS) * 100}%`,
                                  width: `calc(${(note.lengthSlots / TIMELINE_SLOTS) * 100}% - 2px)`,
                                  height: ROW_H - 2,
                                  background: "rgba(0,0,0,0.08)",
                                  borderRadius: 3,
                                  cursor: "pointer",
                                  border: "1px dashed rgba(0,0,0,0.15)",
                                }} />
                            );
                          })}
                          {/* Playhead */}
                          {looping && (
                            <div style={{ position:"absolute", left:`${playheadPct*100}%`, top:0, bottom:0, width:2, background:t.accent, opacity:0.7, pointerEvents:"none" }} />
                          )}
                        </div>
                      </div>
                    );
                  })()}
                  {pianoRollOpen && pianoRollNotes.length > 0 && (
                    <div style={{ display:"flex", gap:8, marginTop:6, alignItems:"center", flexWrap:"wrap" }}>
                      <span style={{ fontSize:10, color:t.textTertiary, fontFamily:SF }}>
                        Click = cycle velocity (pp→mp→mf→ff) · Right-click = mute
                      </span>
                      <div style={{ flex:1 }} />
                      {Object.keys(pianoRollEdits).length > 0 && (
                        <button onClick={() => setPianoRollEdits({})}
                          style={{ fontFamily:SF, fontSize:10, fontWeight:500, padding:"3px 10px", borderRadius:2,
                            border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.textSecondary, cursor:"pointer" }}>
                          Reset edits
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* ── Bass Line ── */}
                <div style={{ marginBottom: 12 }}>
                  <button onClick={() => setBassVisible(o => !o)}
                    style={{ fontFamily:SF, fontSize:11, fontWeight:600, color:t.labelColor, background:"none", border:"none",
                      cursor:"pointer", padding:"4px 0", letterSpacing:"0.06em", textTransform:"uppercase",
                      display:"flex", alignItems:"center", gap:6, opacity:0.8 }}>
                    <span style={{ fontSize:8, transition:"transform 0.2s", transform: bassVisible ? "rotate(90deg)" : "rotate(0)" }}>▶</span>
                    Bass Line {bassLine.length > 0 ? `(${bassLine.length} notes)` : ""}
                  </button>
                  {bassVisible && (
                    <div style={{ marginTop:6, display:"flex", flexDirection:"column", gap:8 }}>
                      <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
                        <select value={bassPattern}
                          onChange={e => { setBassPattern(e.target.value); regenerateBass(e.target.value); }}
                          style={{ fontFamily:SF, fontSize:11, fontWeight:600, padding:"5px 10px", borderRadius:2,
                            border:`1px solid ${t.inputBorder}`, background:t.inputBg, color:t.textPrimary, cursor:"pointer" }}>
                          {Object.entries(BASS_PATTERNS).map(([key, cfg]) => (
                            <option key={key} value={key}>{cfg.label}</option>
                          ))}
                        </select>
                        {timelineItems.length > 0 && (
                          <button onClick={() => regenerateBass()} style={{ fontFamily:SF, fontSize:11, fontWeight:500, padding:"5px 12px", borderRadius:2, border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer" }}>
                            Regen
                          </button>
                        )}
                        {bassLine.length > 0 && (
                          <button onClick={() => setBassLine([])} style={{ fontFamily:SF, fontSize:11, fontWeight:500, padding:"5px 12px", borderRadius:2, border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.textTertiary, cursor:"pointer" }}>
                            Clear
                          </button>
                        )}
                        <div style={{ width:1, height:18, background:t.border }} />
                        <select value={bassSound} onChange={e => setBassSound(e.target.value)}
                          style={{ fontFamily:SF, fontSize:10, fontWeight:600, padding:"4px 8px", borderRadius:2,
                            border:`1px solid ${t.inputBorder}`, background:t.inputBg, color:t.textPrimary, cursor:"pointer" }}>
                          <option value="piano">Piano</option>
                          <option value="808">808 Bass</option>
                        </select>
                        <div style={{ width:1, height:18, background:t.border }} />
                        <span style={{ fontSize:9, fontWeight:700, color:t.textTertiary, textTransform:"uppercase", letterSpacing:"0.06em" }}>Oct</span>
                        <button onClick={() => { setBassOctaveOffset(o => Math.max(-2, o - 1)); }}
                          style={{ fontFamily:SF, fontSize:12, fontWeight:600, width:22, height:22, borderRadius:2,
                            border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer", lineHeight:1, padding:0 }}>−</button>
                        <span style={{ fontFamily:SF, fontSize:11, fontWeight:700, color:t.textPrimary, minWidth:18, textAlign:"center" }}>
                          {bassOctaveOffset === 0 ? "0" : (bassOctaveOffset > 0 ? `+${bassOctaveOffset}` : bassOctaveOffset)}
                        </span>
                        <button onClick={() => { setBassOctaveOffset(o => Math.min(2, o + 1)); }}
                          style={{ fontFamily:SF, fontSize:12, fontWeight:600, width:22, height:22, borderRadius:2,
                            border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer", lineHeight:1, padding:0 }}>+</button>
                      </div>
                      {/* Mini bass visualization */}
                      {bassLine.length > 0 && (
                        <div style={{ height:40, borderRadius:2, border:`1px solid ${t.border}`, background:t.slotBg, position:"relative", overflow:"hidden" }}>
                          {/* Slot lines */}
                          {Array.from({length:TIMELINE_SLOTS}, (_,i) => {
                            if (i === 0) return null;
                            let bg;
                            if (i % SLOTS_PER_BAR === 0) bg = t.border;
                            else if (i % (SLOTS_PER_BAR/4) === 0) bg = "rgba(0,0,0,0.04)";
                            else return null;
                            return <div key={i} style={{ position:"absolute", left:`${i/TIMELINE_SLOTS*100}%`, top:0, bottom:0, width:1, background:bg, pointerEvents:"none" }} />;
                          })}
                          {/* Bass note blocks (active) */}
                          {bassLine.map((note,i) => {
                            if (note.muted) return null;
                            const midiRange = bassLine.reduce((acc, n) => ({ lo: Math.min(acc.lo, n.midi), hi: Math.max(acc.hi, n.midi) }), { lo: 127, hi: 0 });
                            const range = Math.max(1, midiRange.hi - midiRange.lo);
                            const yPct = 1 - (note.midi - midiRange.lo) / range;
                            const densRemoved = densityBass < 100 && !densityPass(densitySeed, "bass", note.startSlot, densityBass, bassImportance(note.startSlot, note.lengthSlots));
                            return (
                              <div key={i}
                                onDoubleClick={() => setBassLine(prev => prev.map((n,j) => j===i ? {...n, muted:true} : n))}
                                style={{
                                  position:"absolute",
                                  left:`${(note.startSlot / TIMELINE_SLOTS) * 100}%`,
                                  width:`calc(${(note.lengthSlots / TIMELINE_SLOTS) * 100}% - 2px)`,
                                  top: `${yPct * 60 + 8}%`, height: 8,
                                  background: densRemoved ? "rgba(52,199,89,0.12)" : "rgba(52,199,89,0.6)", borderRadius:1,
                                  border: densRemoved ? "1px dashed rgba(52,199,89,0.3)" : "1px solid rgba(52,199,89,0.8)",
                                  cursor:"pointer", transition:"background 0.2s, border 0.2s",
                                }} title={`${NOTES[note.midi % 12]}${Math.floor((note.midi-12)/12)} vel:${note.velocity}${densRemoved?" (density removed)":""} — double-click to mute`} />
                            );
                          })}
                          {/* Bass note blocks (muted — double-click to restore) */}
                          {bassLine.map((note,i) => {
                            if (!note.muted) return null;
                            const midiRange = bassLine.reduce((acc, n) => ({ lo: Math.min(acc.lo, n.midi), hi: Math.max(acc.hi, n.midi) }), { lo: 127, hi: 0 });
                            const range = Math.max(1, midiRange.hi - midiRange.lo);
                            const yPct = 1 - (note.midi - midiRange.lo) / range;
                            return (
                              <div key={`m${i}`}
                                onDoubleClick={() => setBassLine(prev => prev.map((n,j) => j===i ? {...n, muted:false} : n))}
                                style={{
                                  position:"absolute",
                                  left:`${(note.startSlot / TIMELINE_SLOTS) * 100}%`,
                                  width:`calc(${(note.lengthSlots / TIMELINE_SLOTS) * 100}% - 2px)`,
                                  top: `${yPct * 60 + 8}%`, height: 8,
                                  background:"rgba(0,0,0,0.08)", borderRadius:1,
                                  border:"1px dashed rgba(0,0,0,0.2)",
                                  cursor:"pointer", opacity:0.5,
                                }} title={`${NOTES[note.midi % 12]}${Math.floor((note.midi-12)/12)} (muted) — double-click to restore`} />
                            );
                          })}
                          {looping && <div style={{ position:"absolute", left:`${playheadPct*100}%`, top:0, bottom:0, width:2, background:"#34C759", opacity:0.7, pointerEvents:"none" }} />}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* ── Topline / Melody ── */}
                <div style={{ marginBottom: 12 }}>
                  <button onClick={() => setMelodyVisible(o => !o)}
                    style={{ fontFamily:SF, fontSize:11, fontWeight:600, color:t.labelColor, background:"none", border:"none",
                      cursor:"pointer", padding:"4px 0", letterSpacing:"0.06em", textTransform:"uppercase",
                      display:"flex", alignItems:"center", gap:6, opacity:0.8 }}>
                    <span style={{ fontSize:8, transition:"transform 0.2s", transform: melodyVisible ? "rotate(90deg)" : "rotate(0)" }}>▶</span>
                    Topline {melodyLine.length > 0 ? `(${melodyLine.length} notes)` : ""}
                  </button>
                  {melodyVisible && (
                    <div style={{ marginTop:6, display:"flex", flexDirection:"column", gap:8 }}>
                      <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
                        <select value={melodyPattern}
                          onChange={e => { setMelodyPattern(e.target.value); regenerateMelody(e.target.value); }}
                          style={{ fontFamily:SF, fontSize:11, fontWeight:600, padding:"5px 10px", borderRadius:2,
                            border:`1px solid ${t.inputBorder}`, background:t.inputBg, color:t.textPrimary, cursor:"pointer" }}>
                          {Object.entries(MELODY_PATTERNS).map(([key, cfg]) => (
                            <option key={key} value={key}>{cfg.label}</option>
                          ))}
                        </select>
                        {timelineItems.length > 0 && (
                          <button onClick={() => regenerateMelody()} style={{ fontFamily:SF, fontSize:11, fontWeight:500, padding:"5px 12px", borderRadius:2, border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer" }}>
                            Regen
                          </button>
                        )}
                        {melodyLine.length > 0 && (
                          <button onClick={() => setMelodyLine([])} style={{ fontFamily:SF, fontSize:11, fontWeight:500, padding:"5px 12px", borderRadius:2, border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.textTertiary, cursor:"pointer" }}>
                            Clear
                          </button>
                        )}
                        <div style={{ width:1, height:18, background:t.border }} />
                        <select value={melodySound} onChange={e => setMelodySound(e.target.value)}
                          style={{ fontFamily:SF, fontSize:10, fontWeight:600, padding:"4px 8px", borderRadius:2,
                            border:`1px solid ${t.inputBorder}`, background:t.inputBg, color:t.textPrimary, cursor:"pointer" }}>
                          <option value="piano">Piano</option>
                          <option value="bell">Bell</option>
                          <option value="pluck">Pluck</option>
                        </select>
                        <div style={{ width:1, height:18, background:t.border }} />
                        <span style={{ fontSize:9, fontWeight:700, color:t.textTertiary, textTransform:"uppercase", letterSpacing:"0.06em" }}>Oct</span>
                        <button onClick={() => { setMelodyOctaveOffset(o => Math.max(-2, o - 1)); }}
                          style={{ fontFamily:SF, fontSize:12, fontWeight:600, width:22, height:22, borderRadius:2,
                            border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer", lineHeight:1, padding:0 }}>−</button>
                        <span style={{ fontFamily:SF, fontSize:11, fontWeight:700, color:t.textPrimary, minWidth:18, textAlign:"center" }}>
                          {melodyOctaveOffset === 0 ? "0" : (melodyOctaveOffset > 0 ? `+${melodyOctaveOffset}` : melodyOctaveOffset)}
                        </span>
                        <button onClick={() => { setMelodyOctaveOffset(o => Math.min(2, o + 1)); }}
                          style={{ fontFamily:SF, fontSize:12, fontWeight:600, width:22, height:22, borderRadius:2,
                            border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer", lineHeight:1, padding:0 }}>+</button>
                      </div>
                      {/* Melody visualization */}
                      {melodyLine.length > 0 && (
                        <div style={{ height:50, borderRadius:2, border:`1px solid ${t.border}`, background:t.slotBg, position:"relative", overflow:"hidden" }}>
                          {/* Slot lines */}
                          {Array.from({length:TIMELINE_SLOTS}, (_,i) => {
                            if (i === 0) return null;
                            let bg;
                            if (i % SLOTS_PER_BAR === 0) bg = t.border;
                            else if (i % (SLOTS_PER_BAR/4) === 0) bg = "rgba(0,0,0,0.04)";
                            else return null;
                            return <div key={i} style={{ position:"absolute", left:`${i/TIMELINE_SLOTS*100}%`, top:0, bottom:0, width:1, background:bg, pointerEvents:"none" }} />;
                          })}
                          {/* Melody note blocks (active) */}
                          {melodyLine.map((note,i) => {
                            if (note.muted) return null;
                            const midiRange = melodyLine.reduce((acc, n) => ({ lo: Math.min(acc.lo, n.midi), hi: Math.max(acc.hi, n.midi) }), { lo: 127, hi: 0 });
                            const range = Math.max(1, midiRange.hi - midiRange.lo);
                            const yPct = 1 - (note.midi - midiRange.lo) / range;
                            const densRemoved = densityMelody < 100 && !densityPass(densitySeed, "melody", note.startSlot, densityMelody, melodyImportance(note.startSlot, note.lengthSlots, note.velocity));
                            return (
                              <div key={i}
                                onDoubleClick={() => setMelodyLine(prev => prev.map((n,j) => j===i ? {...n, muted:true} : n))}
                                style={{
                                  position:"absolute",
                                  left:`${(note.startSlot / TIMELINE_SLOTS) * 100}%`,
                                  width:`calc(${(note.lengthSlots / TIMELINE_SLOTS) * 100}% - 2px)`,
                                  top: `${yPct * 70 + 6}%`, height: 8,
                                  background: densRemoved ? "rgba(255,159,10,0.12)" : "rgba(255,159,10,0.6)", borderRadius:1,
                                  border: densRemoved ? "1px dashed rgba(255,159,10,0.3)" : "1px solid rgba(255,159,10,0.8)",
                                  cursor:"pointer", transition:"background 0.2s, border 0.2s",
                                }} title={`${NOTES[note.midi % 12]}${Math.floor((note.midi-12)/12)} vel:${note.velocity}${densRemoved?" (density removed)":""} — double-click to mute`} />
                            );
                          })}
                          {/* Muted melody notes */}
                          {melodyLine.map((note,i) => {
                            if (!note.muted) return null;
                            const midiRange = melodyLine.reduce((acc, n) => ({ lo: Math.min(acc.lo, n.midi), hi: Math.max(acc.hi, n.midi) }), { lo: 127, hi: 0 });
                            const range = Math.max(1, midiRange.hi - midiRange.lo);
                            const yPct = 1 - (note.midi - midiRange.lo) / range;
                            return (
                              <div key={`m${i}`}
                                onDoubleClick={() => setMelodyLine(prev => prev.map((n,j) => j===i ? {...n, muted:false} : n))}
                                style={{
                                  position:"absolute",
                                  left:`${(note.startSlot / TIMELINE_SLOTS) * 100}%`,
                                  width:`calc(${(note.lengthSlots / TIMELINE_SLOTS) * 100}% - 2px)`,
                                  top: `${yPct * 70 + 6}%`, height: 8,
                                  background:"rgba(0,0,0,0.08)", borderRadius:1,
                                  border:"1px dashed rgba(0,0,0,0.2)",
                                  cursor:"pointer", opacity:0.5,
                                }} title={`${NOTES[note.midi % 12]}${Math.floor((note.midi-12)/12)} (muted) — double-click to restore`} />
                            );
                          })}
                          {looping && <div style={{ position:"absolute", left:`${playheadPct*100}%`, top:0, bottom:0, width:2, background:"#FF9F0A", opacity:0.7, pointerEvents:"none" }} />}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* ── Song Mode / Arrangement ── */}
                <div style={{ marginBottom: 12 }}>
                  <button onClick={() => setSongModeOpen(o => !o)}
                    style={{ fontFamily:SF, fontSize:11, fontWeight:600, color:t.labelColor, background:"none", border:"none",
                      cursor:"pointer", padding:"4px 0", letterSpacing:"0.06em", textTransform:"uppercase",
                      display:"flex", alignItems:"center", gap:6, opacity:0.8 }}>
                    <span style={{ fontSize:8, transition:"transform 0.2s", transform: songModeOpen ? "rotate(90deg)" : "rotate(0)" }}>▶</span>
                    Song Mode {sections.length > 0 ? `(${sections.length} sections)` : ""}
                  </button>
                  {songModeOpen && (
                    <div style={{ marginTop:6, display:"flex", flexDirection:"column", gap:10 }}>
                      {/* Save current as section */}
                      <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
                        <button onClick={() => {
                          const name = prompt("Section name:", `Section ${sections.length + 1}`);
                          if (name) saveSection(name);
                        }} style={{ fontFamily:SF, fontSize:12, fontWeight:600, padding:"7px 16px", borderRadius:2,
                          border:`1px solid ${t.accentBorder}`, background:t.accentBg, color:t.accent, cursor:"pointer" }}>
                          + Save current as section
                        </button>
                        {editingSectionId && (
                          <button onClick={() => updateSection(editingSectionId)}
                            style={{ fontFamily:SF, fontSize:12, fontWeight:500, padding:"7px 16px", borderRadius:2,
                              border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer" }}>
                            Update "{sections.find(s=>s.id===editingSectionId)?.name}"
                          </button>
                        )}
                      </div>

                      {/* Section list */}
                      {sections.length > 0 && (
                        <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                          <div style={{ fontSize:10, fontWeight:600, color:t.textTertiary, textTransform:"uppercase", letterSpacing:"0.06em" }}>Saved sections</div>
                          {sections.map(sec => (
                            <div key={sec.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 10px", borderRadius:2,
                              background: editingSectionId === sec.id ? t.accentBg : t.elevatedBg,
                              border:`1px solid ${editingSectionId === sec.id ? t.accentBorder : t.border}` }}>
                              <span style={{ fontSize:12, fontWeight:600, color:t.textPrimary, fontFamily:SF, flex:1 }}>{sec.name}</span>
                              <span style={{ fontSize:10, color:t.textTertiary }}>{sec.timelineItems.length} chords · {sec.drumPattern ? "drums" : "no drums"} · {sec.bassLine?.length || 0} bass</span>
                              <button onClick={() => loadSection(sec.id)} style={{ fontFamily:SF, fontSize:10, fontWeight:500, padding:"3px 8px", borderRadius:2, border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer" }}>Load</button>
                              <button onClick={() => setArrangement(a => [...a, sec.id])} style={{ fontFamily:SF, fontSize:10, fontWeight:500, padding:"3px 8px", borderRadius:2, border:`1px solid ${t.accentBorder}`, background:t.accentBg, color:t.accent, cursor:"pointer" }}>+ Arr</button>
                              <button onClick={() => deleteSection(sec.id)} style={{ background:"none", border:"none", color:t.textTertiary, cursor:"pointer", fontSize:13, padding:"0 3px" }}>×</button>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Arrangement chain */}
                      {arrangement.length > 0 && (
                        <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                          <div style={{ fontSize:10, fontWeight:600, color:t.textTertiary, textTransform:"uppercase", letterSpacing:"0.06em" }}>Arrangement (playback order)</div>
                          <div style={{ display:"flex", gap:4, flexWrap:"wrap", alignItems:"center" }}>
                            {arrangement.map((secId, idx) => {
                              const sec = sections.find(s => s.id === secId);
                              if (!sec) return null;
                              return (
                                <div key={idx} style={{ display:"flex", alignItems:"center", gap:2 }}>
                                  {idx > 0 && <span style={{ fontSize:10, color:t.textTertiary }}>→</span>}
                                  <div style={{ display:"flex", alignItems:"center", gap:4, padding:"4px 10px", borderRadius:2,
                                    background:t.accentBg, border:`1px solid ${t.accentBorder}` }}>
                                    <span style={{ fontSize:11, fontWeight:600, color:t.accent, fontFamily:SF }}>{sec.name}</span>
                                    <button onClick={() => setArrangement(a => a.filter((_,i) => i !== idx))}
                                      style={{ background:"none", border:"none", color:t.accent, cursor:"pointer", fontSize:11, padding:0, opacity:0.6 }}>×</button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          <div style={{ display:"flex", gap:6, alignItems:"center", marginTop:4 }}>
                            <button onClick={playArrangement}
                              style={{ fontFamily:SF, fontSize:13, fontWeight:700, padding:"8px 22px", borderRadius:2, border:"none",
                                background: arrangementPlaying ? "#FF453A" : "#34C759",
                                color: "#FFFFFF", cursor:"pointer", transition:"all 0.08s",
                              }}>
                              {arrangementPlaying ? "Stop" : "Play Arrangement"}
                            </button>
                            <span style={{ fontSize:10, color:t.textTertiary, fontFamily:SF }}>
                              {arrangement.length} sections · {Math.round(arrangement.length * TIMELINE_SLOTS * (60/bpm) * 0.25)}s
                            </span>
                            <div style={{ flex:1 }} />
                            <button onClick={() => setArrangement([])}
                              style={{ fontFamily:SF, fontSize:10, fontWeight:500, padding:"3px 10px", borderRadius:2,
                                border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.textTertiary, cursor:"pointer" }}>
                              Clear
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* ═══ ZONE 4: TOOLS ═══ */}
                <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center", padding:"6px 0" }}>
                  {/* Chord input */}
                  <input value={chordInput} onChange={e=>{setChordInput(e.target.value);setChordInputErr(false);}}
                    onKeyDown={e=>{ if(e.key!=="Enter") return; const c=parseChordText(chordInput); if(!c){setChordInputErr(true);return;} addChord(c); setChordInput(""); }}
                    placeholder="Fmaj7…"
                    style={{ fontFamily:SF, fontSize:12, padding:"4px 8px", borderRadius:2, border:`1px solid ${chordInputErr?"#E5484D":"rgba(0,0,0,0.12)"}`, background:"#fff", color:t.inputColor, outline:"none", width:100 }}
                  />
                  <button onClick={() => { const c=parseChordText(chordInput); if(!c){setChordInputErr(true);return;} addChord(c); setChordInput(""); }}
                    style={{ fontFamily:SF, fontSize:11, fontWeight:600, padding:"4px 10px", borderRadius:2, border:"none", background:t.accent, color:"#fff", cursor:"pointer" }}>
                    Add
                  </button>
                  {chordInputErr && <span style={{ fontSize:10, color:"#E5484D", fontFamily:SF }}>?</span>}

                  <div style={{ width:1, height:18, background:t.border }} />

                  <button onClick={() => { stopLoop(); setTimelineItems([]); setActiveChord(null); }}
                    style={{ fontFamily:SF, fontSize:11, fontWeight:500, padding:"4px 10px", borderRadius:2, border:`1px solid rgba(0,0,0,0.15)`, background:"transparent", color:"rgba(0,0,0,0.50)", cursor:"pointer" }}>
                    Clear
                  </button>
                  <button onClick={() => {
                    stopLoop();
                    const len = [3,4,4,4][Math.floor(Math.random()*4)];
                    const cs = Array.from({length:len}, () => chords[Math.floor(Math.random()*7)]);
                    let slot = 0;
                    const items = [];
                    cs.forEach(chord => {
                      if (slot >= TIMELINE_SLOTS) return;
                      const len2 = Math.min(DEFAULT_CHORD_LEN, TIMELINE_SLOTS - slot);
                      items.push({ id: Date.now()+Math.random(), chord, startSlot:slot, lengthSlots:len2 });
                      slot += len2;
                    });
                    setTimelineItems(items); setActiveChord(cs[0]);
                  }} style={{ fontFamily:SF, fontSize:11, fontWeight:500, padding:"4px 10px", borderRadius:2, border:`1px solid rgba(0,0,0,0.15)`, background:"transparent", color:"rgba(0,0,0,0.50)", cursor:"pointer" }}>
                    Random
                  </button>
                  <button onClick={() => {
                    stopLoop();
                    const PREFERRED_GENRES = ["Hip-Hop","R&B","Nordic Pop","Radiohead","Soul","Dark"];
                    const preferred = FAMOUS_PROGRESSIONS.filter(p => PREFERRED_GENRES.includes(p.genre));
                    const other = FAMOUS_PROGRESSIONS.filter(p => !PREFERRED_GENRES.includes(p.genre));
                    const pool = Math.random() < 0.8 && preferred.length > 0 ? preferred : other.length > 0 ? other : FAMOUS_PROGRESSIONS;
                    const pick = pool[Math.floor(Math.random()*pool.length)];
                    const scaleObj = SCALES[scaleKey];
                    const seventhList = scaleKey==="major" ? SEVENTHS_MAJOR : scaleKey==="minor" ? SEVENTHS_MINOR : SEVENTHS_OTHER;
                    const ninthList   = scaleKey==="major" ? NINTHS_MAJOR   : scaleKey==="minor" ? NINTHS_MINOR   : NINTHS_OTHER;
                    const suffixOf = q =>
                      q==="maj"?"": q==="min"?"m": q==="dim"?"\u00B0":
                      q==="maj7"?"maj7": q==="m7"?"m7": q==="7"?"7":
                      q==="m7b5"?"m7b5": q==="maj9"?"maj9":
                      q==="m9"?"m9": q==="9"?"9":
                      q==="sus2"?"sus2": q==="sus4"?"sus4": q==="5"?"5": q;
                    const embellishIdx = Math.random() < 0.7 ? -1 : Math.floor(Math.random() * pick.degrees.length);
                    const EMBELLISH_POOL = ["7","7","sus4","sus2","5"];
                    const cs = pick.degrees.map((d, idx) => {
                      const i = d % 7;
                      const noteIdx = (rootIdx + scaleObj.intervals[i]) % 12;
                      const baseQ   = scaleObj.qualities[i];
                      let quality = baseQ;
                      if (idx === embellishIdx && baseQ !== "dim") {
                        const v = EMBELLISH_POOL[Math.floor(Math.random()*EMBELLISH_POOL.length)];
                        if      (v==="7")    quality = seventhList[i];
                        else if (v==="sus4") quality = "sus4";
                        else if (v==="sus2") quality = "sus2";
                        else if (v==="5")    quality = "5";
                      }
                      return { noteIdx, quality, degree:scaleObj.degrees[i], display:NOTES[noteIdx]+suffixOf(quality) };
                    });
                    let slot = 0;
                    const items = [];
                    cs.forEach(chord => {
                      if (slot >= TIMELINE_SLOTS) return;
                      const len2 = Math.min(DEFAULT_CHORD_LEN, TIMELINE_SLOTS - slot);
                      items.push({ id: Date.now()+Math.random(), chord, startSlot:slot, lengthSlots:len2 });
                      slot += len2;
                    });
                    setTimelineItems(items); setActiveChord(cs[0]);
                  }} style={{ fontFamily:SF, fontSize:11, fontWeight:600, padding:"4px 10px", borderRadius:2, border:`1px solid ${t.accentBorder}`, background:t.accentBg, color:t.accent, cursor:"pointer" }}>
                    Suggest
                  </button>

                  <div style={{ flex:1 }} />

                  {/* Project */}
                  <span style={{ fontSize:8, fontWeight:700, color:"rgba(0,0,0,0.40)", letterSpacing:"0.10em", textTransform:"uppercase", fontFamily:SF }}>PROJECT</span>
                  <button onClick={() => {
                    if (!window.confirm("Start a new project? All unsaved changes will be lost.")) return;
                    setRootDisplay("C"); setScaleKey("major"); setChordType("triad"); setChordOctave(4);
                    setBpm(90); setTimelineItems([]); setSoundType("rhodes");
                    setDrumPattern(null); setDrumGenre("boombap_classic"); setBassLine([]); setBassPattern("root");
                    setMelodyLine([]); setMelodyPattern("chordTones");
                    setSections([]); setArrangement([]);
                    setMelodySound("bell"); setBassSound("808"); setBassOctaveOffset(0); setMelodyOctaveOffset(0);
                    setPlayStyle("normal"); setChordPlayPattern("sustained"); setChordRhythmMutes({});
                    setArpOn(false); setArpPattern("up"); setArpRate(0.5);
                    setLockedTracks({}); setMutedTracks({}); mutedTracksRef.current = {};
                    setSoloTrack(null); soloTrackRef.current = null;
                    setTripletTracks({}); tripletTracksRef.current = {};
                    setDrumSwing(0); drumSwingRef.current = 0;
                    setDrumHalfTime(false); drumHalfTimeRef.current = false;
                    setDrumFavorites([]);
                    setPadMap(DRUM_TRACKS.reduce((acc, tr) => ({ ...acc, [tr.id]: { padId:tr.defaultPad, midiNote:tr.defaultNote }}), {}));
                    setDensityDrums(100); densityDrumsRef.current = 100;
                    setDensityBass(100); densityBassRef.current = 100;
                    setDensityMelody(100); densityMelodyRef.current = 100;
                    setDensityChords(100); densityChordsRef.current = 100;
                    setDensitySeed(1); densitySeedRef.current = 1;
                    setVariationAmount(0); variationAmountRef.current = 0;
                    setEnergy(75); energyRef.current = 75;
                    setFillMode("off"); fillModeRef.current = "off"; fillNextRef.current = false; fillJustPlayedRef.current = false; loopCountRef.current = 0;
                    setMuteChords(false); setMuteBass(false); setMuteMelody(false); setMuteDrums(false);
                    setPianoRollEdits({}); setHumanize(0); setLoopEnabled(true); loopEnabledRef.current = true;
                    localStorage.removeItem("fiskaturet_project");
                  }}
                    style={{ fontFamily:SF, fontSize:10, fontWeight:500, padding:"3px 8px", borderRadius:2,
                      border:`1px solid rgba(0,0,0,0.15)`, background:"transparent", color:"rgba(0,0,0,0.45)", cursor:"pointer" }}>
                    New
                  </button>
                  <button onClick={() => {
                    const json = JSON.stringify(serializeProject(), null, 2);
                    const blob = new Blob([json], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `fiskaturet-${rootDisplay}-${scaleKey}-${bpm}bpm.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                    style={{ fontFamily:SF, fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:2,
                      border:`1px solid ${t.accentBorder}`, background:t.accentBg, color:t.accent, cursor:"pointer" }}>
                    Save
                  </button>
                  <button onClick={() => fileInputRef.current && fileInputRef.current.click()}
                    style={{ fontFamily:SF, fontSize:10, fontWeight:500, padding:"3px 8px", borderRadius:2,
                      border:`1px solid rgba(0,0,0,0.15)`, background:"transparent", color:"rgba(0,0,0,0.45)", cursor:"pointer" }}>
                    Load
                  </button>
                  <input ref={fileInputRef} type="file" accept=".json" style={{ display:"none" }}
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = ev => {
                        try {
                          const data = JSON.parse(ev.target.result);
                          loadProject(data);
                        } catch (err) {
                          alert("Failed to load project file: " + err.message);
                        }
                      };
                      reader.readAsText(file);
                      e.target.value = "";
                    }}
                  />
                  {lastAutoSave && <span style={{ fontSize:9, color:"rgba(0,0,0,0.40)", fontFamily:MONO }}>saved</span>}

                  <div style={{ width:1, height:16, background:t.border }} />

                  {/* MPC Export */}
                  <button onClick={downloadMidi}
                    disabled={timelineItems.length === 0 && !drumPattern && bassLine.length === 0 && melodyLine.length === 0}
                    style={{ fontFamily:SF, fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:2,
                      border:`1px solid ${t.accentBorder}`, background:t.accentBg, color:t.accent,
                      cursor: (timelineItems.length === 0 && !drumPattern && bassLine.length === 0 && melodyLine.length === 0) ? "default" : "pointer",
                      opacity: (timelineItems.length === 0 && !drumPattern && bassLine.length === 0 && melodyLine.length === 0) ? 0.35 : 1 }}>
                    MIDI
                  </button>
                  <button onClick={downloadDrumProgram}
                    style={{ fontFamily:SF, fontSize:10, fontWeight:500, padding:"3px 8px", borderRadius:2,
                      border:`1px solid rgba(0,0,0,0.15)`, background:"transparent", color:"rgba(0,0,0,0.45)", cursor:"pointer" }}>
                    .xpm
                  </button>
                  <button onClick={() => setChordPadMode(m => !m)}
                    style={{ fontFamily:MONO, fontSize:9, fontWeight:700, padding:"2px 6px", borderRadius:1,
                      border:`1px solid ${chordPadMode ? "#2B9A3E" : "rgba(0,0,0,0.15)"}`,
                      background: chordPadMode ? "rgba(43,154,62,0.08)" : "transparent",
                      color: chordPadMode ? "#2B9A3E" : "rgba(0,0,0,0.50)", cursor:"pointer", letterSpacing:"0.04em" }}>
                    {chordPadMode ? "PAD ON" : "PAD"}
                  </button>
                  {chordPadMode && <span style={{ fontSize:9, color:"#2B9A3E", fontFamily:MONO }}>A1–A7 → I–VII</span>}
                  {arrangement.length > 0 && (
                    <button onClick={() => {
                      const data = exportToMidi({
                        timelineItems, drumPattern, bassLine, melodyLine, bpm, chordOctave, padMap,
                        pianoRollEdits, TIMELINE_SLOTS, DRUM_TRACKS, sections, arrangement,
                      });
                      const blob = new Blob([data], { type: "audio/midi" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "fiskaturet-arrangement.mid";
                      a.click();
                      URL.revokeObjectURL(url);
                    }} style={{ fontFamily:SF, fontSize:10, fontWeight:600, padding:"3px 8px", borderRadius:2,
                      border:`1px solid rgba(43,154,62,0.5)`, background:"rgba(43,154,62,0.06)", color:"#2B9A3E", cursor:"pointer" }}>
                      Arr MIDI
                    </button>
                  )}
                </div>
              </div>
            </>
          )}

        </div>
      </div>
    </>
  );
}
