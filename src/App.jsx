import { useState, useRef, useCallback, useEffect } from "react";
import * as Tone from "tone";
import JSZip from "jszip";

// ─── Sampler ─────────────────────────────────────────────────────────────────

let sampler = null;
function getSampler() {
  if (!sampler) {
    sampler = new Tone.Sampler({
      urls: {
        A1:"A1.mp3", A2:"A2.mp3", A3:"A3.mp3", A4:"A4.mp3", A5:"A5.mp3", A6:"A6.mp3", A7:"A7.mp3",
        C1:"C1.mp3", C2:"C2.mp3", C3:"C3.mp3", C4:"C4.mp3", C5:"C5.mp3", C6:"C6.mp3", C7:"C7.mp3",
        "D#1":"Ds1.mp3","D#2":"Ds2.mp3","D#3":"Ds3.mp3","D#4":"Ds4.mp3","D#5":"Ds5.mp3","D#6":"Ds6.mp3","D#7":"Ds7.mp3",
        "F#1":"Fs1.mp3","F#2":"Fs2.mp3","F#3":"Fs3.mp3","F#4":"Fs4.mp3","F#5":"Fs5.mp3","F#6":"Fs6.mp3","F#7":"Fs7.mp3",
      },
      release: 1,
      baseUrl: "https://tonejs.github.io/audio/salamander/",
    }).toDestination();
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

// ─── Theme ───────────────────────────────────────────────────────────────────

const THEME = {
  pageBg:"#1A1C20", cardBg:"#22252C", elevatedBg:"#2A2D34",
  textPrimary:"#E8E2D4", textSecondary:"#8A8680", textTertiary:"#484540",
  labelColor:"#D4880A", border:"rgba(255,255,255,0.07)",
  inputBorder:"rgba(255,255,255,0.1)", inputBg:"#12141A", inputColor:"#E8E2D4", colorScheme:"dark",
  cardShadow:"0 2px 0 rgba(0,0,0,0.6),0 8px 32px rgba(0,0,0,0.4),inset 0 1px 0 rgba(255,255,255,0.05)",
  accent:"#E8920C", accentBg:"rgba(232,146,12,0.13)", accentBgHover:"rgba(232,146,12,0.20)",
  accentBorder:"rgba(232,146,12,0.45)", accentCardBg:"rgba(232,146,12,0.08)", accentCardHover:"rgba(232,146,12,0.13)",
  degreeColor:"#484540", chordNameColor:"#E8E2D4", chordCardBg:"#2A2D34",
  chordHoverShadow:"0 6px 24px rgba(232,146,12,0.22)",
  segBg:"rgba(0,0,0,0.45)", segActiveBg:"#32363F", segActiveColor:"#E8E2D4",
  segInactiveColor:"#585450", segShadow:"inset 0 1px 3px rgba(0,0,0,0.6),0 1px 0 rgba(255,255,255,0.04)",
  pianoRailBg:"#0C0E12", pianoRailShadow:"inset 0 3px 10px rgba(0,0,0,0.9)", pianoKeysBg:"#181A1F",
  whiteKeyBg:"#D4D0C8", whiteKeyScaleBg:"rgba(232,146,12,0.18)",
  whiteKeyHlBg:"linear-gradient(180deg,#F5A428 0%,#C07010 100%)",
  whiteKeyAllScaleBg:"linear-gradient(180deg,#F5A428 0%,#C07010 100%)",
  whiteKeyBorder:"rgba(0,0,0,0.35)", whiteKeyLabel:"rgba(0,0,0,0.28)", whiteKeyLabelHl:"#7A3800",
  blackKeyBg:"#0C0E12", blackKeyScaleBg:"#7A4A0C",
  blackKeyHlBg:"#C07010", blackKeyAllScaleBg:"#C07010",
  legendChord:"linear-gradient(180deg,#F5A428,#C07010)", legendScale:"rgba(232,146,12,0.15)", legendScaleBdr:"rgba(232,146,12,0.3)",
  slotBg:"#12141A", slotBorder:"rgba(255,255,255,0.04)",
  tokenBg:"#2A2D34", tokenBgHover:"rgba(232,146,12,0.18)", tokenBorder:"rgba(232,146,12,0.5)", tokenColor:"#E8920C",
  playActiveBg:"#E8920C", playDisabledBg:"#1E2126", playDisabledClr:"#3A3835",
  btnBg:"#2A2D34", btnColor:"#C8C2B4", btnBorder:"rgba(255,255,255,0.09)",
  presetBg:"#2A2D34", presetColor:"#C8C2B4",
  toggleBg:"#2A2D34", toggleColor:"#C8C2B4", toggleBorder:"rgba(255,255,255,0.09)",
  stepBg:"#22252C", stepColor:"#585450",
  stepWholeBg:"rgba(232,146,12,0.13)", stepWholeColor:"#E8920C", stepWholeBorder:"rgba(232,146,12,0.28)",
  stepHalfBg:"#2A2D34", stepHalfColor:"#585450", stepHalfBorder:"rgba(255,255,255,0.07)",
  infoBg:"#1E2126", infoBorder:"rgba(255,255,255,0.04)",
  modeBtnActiveBg:"#32363F", modeBtnActiveBorder:"rgba(255,255,255,0.14)", modeBtnActiveColor:"#E8E2D4",
  modeBtnBg:"transparent", modeBtnBorder:"transparent", modeBtnColor:"rgba(200,194,180,0.32)",
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
];

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

  return (
    <div style={{ position:"relative", width:"100%", height:130, userSelect:"none" }}>
      {whiteKeys.map((k,i) => {
        const hl = highlightedNotes.includes(k.noteIdx) && (highlightAllOctaves || k.octave===4);
        const sc = !highlightAllOctaves && scaleNoteIndices.includes(k.noteIdx);
        return (
          <div key={i} onClick={() => onNoteClick?.(k.name+k.octave)} style={{
            position:"absolute", left:`calc(${k.pos*wkw}% + 1px)`, width:`calc(${wkw}% - 2px)`,
            height:"100%",
            background: hl ? t.whiteKeyAllScaleBg : sc ? t.whiteKeyScaleBg : t.whiteKeyBg,
            border:`1px solid ${t.whiteKeyBorder}`, borderTop:"none",
            borderRadius:"0 0 8px 8px", cursor:"pointer",
            transition:"background 0.12s ease",
            display:"flex", alignItems:"flex-end", justifyContent:"center",
            paddingBottom:8, boxSizing:"border-box",
          }}>
            {k.noteIdx===0 && (
              <span style={{ fontSize:8.5, fontFamily:"SF Pro Text,-apple-system,sans-serif",
                color: hl ? t.whiteKeyLabelHl : t.whiteKeyLabel, fontWeight:hl?600:400 }}>
                C{k.octave}
              </span>
            )}
          </div>
        );
      })}
      {blackKeys.map((k,i) => {
        const hl = highlightedNotes.includes(k.noteIdx) && (highlightAllOctaves || k.octave===4);
        const sc = !highlightAllOctaves && scaleNoteIndices.includes(k.noteIdx);
        return (
          <div key={i} onClick={e => { e.stopPropagation(); onNoteClick?.(k.name+k.octave); }} style={{
            position:"absolute", left:`${k.leftPct}%`, width:`${wkw*0.56}%`, height:"60%",
            background: hl ? t.blackKeyAllScaleBg : sc ? t.blackKeyScaleBg : t.blackKeyBg,
            borderRadius:"0 0 5px 5px", zIndex:2, cursor:"pointer",
            transition:"background 0.12s ease",
            boxShadow:"0 4px 10px rgba(0,0,0,0.5),inset 0 -1px 0 rgba(255,255,255,0.07)",
            display:"flex", alignItems:"flex-end", justifyContent:"center", paddingBottom:4,
          }}>
            <span style={{
              fontSize:7, fontFamily:"SF Pro Text,-apple-system,sans-serif", lineHeight:1,
              color: hl ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.38)",
              fontWeight: hl ? 700 : 400, userSelect:"none",
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
    <div style={{ display:"inline-flex", background:t.segBg, borderRadius:9, padding:2, gap:2 }}>
      {options.map(opt => (
        <button key={opt.value} onClick={() => onChange(opt.value)} style={{
          padding:"5px 14px", borderRadius:7, border:"none",
          background: value===opt.value ? t.segActiveBg : "transparent",
          boxShadow:  value===opt.value ? t.segShadow : "none",
          fontFamily:"SF Pro Text,-apple-system,sans-serif", fontSize:13,
          fontWeight: value===opt.value ? 510 : 400,
          color: value===opt.value ? t.segActiveColor : t.segInactiveColor,
          cursor:"pointer", transition:"all 0.12s ease", whiteSpace:"nowrap",
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

  const SF2   = "Rajdhani,'SF Pro Display',system-ui,sans-serif";
  const card2 = { background:t.cardBg, borderRadius:18, padding:"20px 24px", boxShadow:t.cardShadow, marginBottom:12 };
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
              padding:"8px 20px", borderRadius:10,
              background: detectMode===key ? t.accent    : t.elevatedBg,
              border:     `1px solid ${detectMode===key ? t.accent : t.border}`,
              color:      detectMode===key ? "#FFFFFF"   : t.textSecondary,
              cursor:"pointer", transition:"all 0.12s ease",
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
                fontFamily:SF2, fontSize:13, fontWeight:600, padding:"8px 22px", borderRadius:10, border:"none",
                background: listening ? "#FF453A" : t.accent, color:"#FFFFFF", cursor:"pointer", transition:"background 0.15s",
              }}>
                {listening ? "⬛ Stop" : "🎤 Start"}
              </button>
              <button onClick={resetMic} style={{
                fontFamily:SF2, fontSize:13, fontWeight:500, padding:"8px 16px", borderRadius:10,
                border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer",
              }}>Reset</button>
            </div>
          </div>
          {micError && (
            <div style={{ marginTop:12, padding:"10px 14px", borderRadius:10,
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
                    borderRadius:14, border:"none", background:"#FF453A",
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
                    borderRadius:14, border:"none", background:t.accent,
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
              <div style={{ height:6, borderRadius:3, background:t.elevatedBg, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${fileProgress}%`, borderRadius:3,
                  background:`linear-gradient(90deg, ${t.accent}, #5E9BFF)`, transition:"width 0.2s ease" }} />
              </div>
              <button onClick={() => { abortRef.current = true; setFileAnalyzing(false); }}
                style={{ marginTop:12, fontFamily:SF2, fontSize:12, fontWeight:500, padding:"6px 14px",
                  borderRadius:8, border:`1px solid ${t.btnBorder}`, background:t.btnBg,
                  color:t.btnColor, cursor:"pointer" }}>
                Cancel
              </button>
            </div>
          )}

          {fileError && !fileAnalyzing && !isRecording && (
            <div style={{ marginTop:10, padding:"10px 14px", borderRadius:10,
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
              <div style={{ height:6, borderRadius:3, background:t.elevatedBg, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${confidence}%`, borderRadius:3,
                  background:`linear-gradient(90deg, ${t.accent}, #5E9BFF)`, transition:"width 0.3s ease" }} />
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
                      padding:"5px 14px", borderRadius:20,
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
                    width:"100%", height:`${Math.max(pct*100,2)}%`, borderRadius:"4px 4px 0 0",
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

function SheetMusicTab({ t, soundType, getMIDIOut, midiChannel }) {
  const [dragOver,   setDragOver]   = useState(false);
  const [parsedData, setParsedData] = useState(null);
  const [fileName,   setFileName]   = useState(null);
  const [parseError, setParseError] = useState(null);
  const [playing,    setPlaying]    = useState(false);
  const [userBpm,    setUserBpm]    = useState(120);
  const playTimerRef  = useRef(null);
  const timeoutsRef   = useRef([]);

  const SF2 = "Rajdhani,'SF Pro Display',system-ui,sans-serif";
  const card2 = { background:t.cardBg, borderRadius:18, padding:"20px 24px", boxShadow:t.cardShadow, marginBottom:12 };
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
    setPlaying(false);
  }, []);

  const playSheet = useCallback(async () => {
    if (playing) { stopSheet(); return; }
    if (!parsedData) return;

    // Scale all times by original_tempo / user_tempo
    const scale = parsedData.tempo / userBpm;
    const midiOut = getMIDIOut();

    if (midiOut) {
      const ch = midiChannel - 1;
      timeoutsRef.current = [];
      parsedData.events.forEach(e => {
        const startMs = e.time * scale * 1000;
        const durMs   = e.duration * scale * 900;
        e.notes.forEach((noteName, i) => {
          const n = nameToMidi(noteName);
          const t1 = setTimeout(() => {
            midiOut.send([0x90 | ch, n, 90]);
            const t2 = setTimeout(() => midiOut.send([0x80 | ch, n, 0]), durMs);
            timeoutsRef.current.push(t2);
          }, startMs + i * 8);
          timeoutsRef.current.push(t1);
        });
      });
    } else {
      await Tone.start();
      const inst = getInstrument(soundType);
      if (soundType === "piano") await Tone.loaded();
      const now = Tone.now();
      parsedData.events.forEach(e => {
        e.notes.forEach((noteName, i) => {
          inst.triggerAttackRelease(noteName, String(e.duration * scale * 0.9), now + e.time * scale + i * 0.008);
        });
      });
    }

    setPlaying(true);
    playTimerRef.current = setTimeout(stopSheet, (parsedData.duration * scale + 0.8) * 1000);
  }, [playing, parsedData, userBpm, soundType, getMIDIOut, midiChannel, stopSheet]);

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
            borderRadius:14, padding:"36px 24px", textAlign:"center", cursor:"pointer",
            background: dragOver ? t.accentBg : t.elevatedBg,
            transition:"all 0.15s ease",
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
          <div style={{ marginTop:10, padding:"10px 14px", borderRadius:10,
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
                    <button onClick={() => !playing && setUserBpm(b => Math.max(20, b - 1))}
                      style={{ fontFamily:SF2, fontSize:13, fontWeight:600, width:26, height:26, borderRadius:8,
                        border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer", lineHeight:1 }}>−</button>
                    <input
                      type="number" min={20} max={300} value={userBpm}
                      disabled={playing}
                      onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v) && v >= 20 && v <= 300) setUserBpm(v); }}
                      style={{ fontFamily:SF2, fontSize:14, fontWeight:700, textAlign:"center",
                        width:58, padding:"4px 6px", borderRadius:8,
                        border:`1px solid ${t.inputBorder}`, background: playing ? t.elevatedBg : t.inputBg,
                        color:t.inputColor, appearance:"textfield", MozAppearance:"textfield" }}
                    />
                    <button onClick={() => !playing && setUserBpm(b => Math.min(300, b + 1))}
                      style={{ fontFamily:SF2, fontSize:13, fontWeight:600, width:26, height:26, borderRadius:8,
                        border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer", lineHeight:1 }}>+</button>
                    {parsedData.tempo !== userBpm && !playing && (
                      <button onClick={() => setUserBpm(parsedData.tempo)}
                        style={{ fontFamily:SF2, fontSize:11, fontWeight:500, padding:"4px 10px", borderRadius:8,
                          border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.textSecondary, cursor:"pointer" }}>
                        Reset
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <button onClick={playSheet} style={{
              fontFamily:SF2, fontSize:14, fontWeight:600,
              padding:"11px 30px", borderRadius:12, border:"none",
              background: playing ? "#FF453A" : t.accent,
              color:"#FFFFFF", cursor:"pointer", transition:"background 0.15s",
              flexShrink:0, alignSelf:"flex-start",
            }}>
              {playing ? "⬛ Stop" : "▶  Play"}
            </button>
          </div>
          {playing && (
            <div style={{ marginTop:14, display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ width:7, height:7, borderRadius:"50%", background:"#30D158",
                boxShadow:"0 0 0 2px rgba(48,209,88,0.3)", display:"inline-block",
                animation:"pulse 1.2s ease-in-out infinite" }} />
              <span style={{ fontSize:12, fontWeight:600, color:"#30D158", fontFamily:SF2, letterSpacing:"0.05em" }}>
                PLAYING
              </span>
            </div>
          )}
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

// ─── App ──────────────────────────────────────────────────────────────────────

const SF = "Rajdhani,'SF Pro Display',system-ui,sans-serif";

export default function App() {
  const [soundType,    setSoundType]    = useState("piano"); // "piano" | "rhodes"
  const [mode,         setMode]         = useState("chords"); // "chords" | "scales" | "detect"
  const [rootDisplay,  setRootDisplay]  = useState("C");
  const [scaleKey,     setScaleKey]     = useState("major");
  const [chordType,    setChordType]    = useState("triad");
  const [timelineItems, setTimelineItems] = useState([]); // { id, chord, startSlot, lengthSlots }
  const [hoveredChord, setHoveredChord] = useState(null);
  const [activeChord,  setActiveChord]  = useState(null);
  const [bpm,          setBpm]          = useState(90);
  const [looping,      setLooping]      = useState(false);
  const [playheadPct,  setPlayheadPct]  = useState(0);
  const [arpOn,        setArpOn]        = useState(false);
  const [arpPattern,   setArpPattern]   = useState("up");
  const [arpRate,      setArpRate]      = useState(0.5);
  const [chordOctave,  setChordOctave]  = useState(4);
  const [chordInput,   setChordInput]   = useState("");
  const [chordInputErr,setChordInputErr]= useState(false);
  const [midiOutputs,  setMidiOutputs]  = useState([]);
  const [midiOutputId, setMidiOutputId] = useState("off");
  const [midiChannel,  setMidiChannel]  = useState(1);
  const [midiError,    setMidiError]    = useState(null);
  const loopRef    = useRef(null);
  const rafRef     = useRef(null);
  const dragRef    = useRef(null);
  const trackRef   = useRef(null);
  const midiAccess = useRef(null);

  // ── MIDI init ──
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
    }).catch(() => setMidiError("MIDI access denied. Allow MIDI in browser permissions."));
  }, []);

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

  const t = THEME;

  const card = {
    background:t.cardBg, borderRadius:18, padding:"20px 24px",
    boxShadow:t.cardShadow, marginBottom:12,
  };
  const labelStyle = {
    fontSize:11, display:"block", marginBottom:6, color:t.labelColor,
    fontWeight:600, textTransform:"uppercase", letterSpacing:"0.07em", fontFamily:SF,
  };
  const selectStyle = {
    fontFamily:SF, padding:"7px 12px", borderRadius:10,
    border:`1px solid ${t.inputBorder}`, fontSize:14, fontWeight:500,
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
  const TIMELINE_SLOTS = 8; // 4 bars × 2 half-notes

  const isSlotFree = (items, startSlot, lengthSlots, excludeId = null) => {
    for (let s = startSlot; s < startSlot + lengthSlots; s++) {
      if (items.some(it => it.id !== excludeId && s >= it.startSlot && s < it.startSlot + it.lengthSlots))
        return false;
    }
    return true;
  };

  const addChord = (chord) => {
    setActiveChord(chord);
    const noteNames = getChordNoteNames(chord.noteIdx, chord.quality, chordOctave);
    // Find first free slot for a 2-slot block
    setTimelineItems(prev => {
      let start = 0;
      while (start < TIMELINE_SLOTS) {
        const len = Math.min(2, TIMELINE_SLOTS - start);
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

  const stopLoop = () => {
    if (loopRef.current)  { clearInterval(loopRef.current);      loopRef.current = null; }
    if (rafRef.current)   { cancelAnimationFrame(rafRef.current); rafRef.current  = null; }
    setLooping(false);
    setPlayheadPct(0);
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
    if (timelineItems.length === 0) return;
    await Tone.start();
    const midiOut = getMIDIOut();
    let inst = null;
    if (!midiOut) { inst = getInstrument(soundType); if (soundType === "piano") await Tone.loaded(); }

    const slotSec   = (60 / bpm) * 2;
    const totalSec  = TIMELINE_SLOTS * slotSec;
    const totalMs   = totalSec * 1000;

    const doSchedule = (offsetNow) => {
      const base = offsetNow ?? Tone.now();
      timelineItems.forEach(item => {
        const noteNames = getChordNoteNames(item.chord.noteIdx, item.chord.quality, chordOctave);
        const startSec  = item.startSlot * slotSec;
        const durSec    = item.lengthSlots * slotSec;
        const ch = midiChannel - 1;
        if (midiOut) {
          if (arpOn) {
            const rateSec = (60/bpm)*arpRate, rateMs = rateSec*1000;
            const steps = Math.round(durSec/rateSec);
            const ordered = getArpNotes(noteNames, arpPattern);
            for (let i=0;i<steps;i++) {
              const n = nameToMidi(ordered[i%ordered.length]);
              const {offsetSec,vel} = arpHumanize(i,rateSec);
              const midiVel = Math.round(vel*100+15);
              setTimeout(()=>{ midiOut.send([0x90|ch,n,midiVel]); setTimeout(()=>midiOut.send([0x80|ch,n,0]),rateMs*0.85); },(startSec+i*rateSec+offsetSec)*1000);
            }
          } else {
            const offsets = strumOffsets(noteNames.length), vels = humanVelocities(noteNames.length);
            noteNames.forEach((note,i) => {
              const midiVel = Math.floor(vels[i]*100+15);
              setTimeout(()=>{ midiOut.send([0x90|ch,nameToMidi(note),midiVel]); setTimeout(()=>midiOut.send([0x80|ch,nameToMidi(note),0]),durSec*0.85*1000); },(startSec+offsets[i])*1000);
            });
          }
        } else {
          if (arpOn) {
            const rateSec = (60/bpm)*arpRate, steps = Math.round(durSec/rateSec);
            const ordered = getArpNotes(noteNames, arpPattern);
            for (let i=0;i<steps;i++) {
              const {offsetSec,vel} = arpHumanize(i,rateSec);
              inst.triggerAttackRelease(ordered[i%ordered.length],rateSec*0.85,base+startSec+i*rateSec+offsetSec,vel);
            }
          } else {
            const offsets = strumOffsets(noteNames.length), vels = humanVelocities(noteNames.length);
            noteNames.forEach((note,i) => inst.triggerAttackRelease(note,`${durSec*0.85}`,base+startSec+offsets[i],vels[i]));
          }
        }
      });
    };

    doSchedule();
    setLooping(true);
    const wallStart = performance.now();
    const animate = () => {
      const pct = ((performance.now() - wallStart) % totalMs) / totalMs;
      setPlayheadPct(pct);
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    loopRef.current = setInterval(() => doSchedule(Tone.now()), totalMs);
  };

  useEffect(() => () => stopLoop(), []);

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box}
        html,body{margin:0;background:${t.pageBg};font-family:${SF};transition:background 0.2s ease}
        select:focus,button:focus{outline:none}
        option{background:${t.inputBg};color:${t.inputColor}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
        @keyframes led-glow{0%,100%{box-shadow:0 0 4px #E8920C,0 0 8px rgba(232,146,12,0.5)}50%{box-shadow:0 0 8px #E8920C,0 0 16px rgba(232,146,12,0.7)}}
        input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
        ::-webkit-scrollbar{width:6px;height:6px}
        ::-webkit-scrollbar-track{background:${t.pageBg}}
        ::-webkit-scrollbar-thumb{background:#3A3D44;border-radius:3px}
        ::-webkit-scrollbar-thumb:hover{background:#4A4D54}
        .bpm-lcd{font-family:'Share Tech Mono',monospace !important;letter-spacing:0.08em}
      `}</style>

      <div style={{ minHeight:"100vh", background:t.pageBg, padding:"2.5rem 1rem", fontFamily:SF, transition:"background 0.2s ease" }}>
        <div style={{ maxWidth:860, margin:"0 auto" }}>

          {/* ── Header ── */}
          <div style={{
            background:"linear-gradient(180deg,#2E3138 0%,#1E2126 100%)",
            borderRadius:14, padding:"18px 28px", marginBottom:16,
            boxShadow:"0 2px 0 rgba(0,0,0,0.7),0 8px 24px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.07)",
            border:"1px solid rgba(255,255,255,0.06)",
            display:"flex", justifyContent:"space-between", alignItems:"center",
          }}>
            <div>
              <h1 style={{
                fontSize:28, fontWeight:700, letterSpacing:"0.18em",
                textTransform:"uppercase", color:"#E8E2D4", margin:0,
                fontFamily:SF, textShadow:"0 0 20px rgba(232,146,12,0.15)",
              }}>
                Fiskaturet
              </h1>
              <p style={{ fontSize:11, color:t.labelColor, margin:"5px 0 0", fontWeight:600,
                letterSpacing:"0.2em", textTransform:"uppercase", fontFamily:SF }}>
                {mode==="detect" ? "Key Detector · Microphone"
                  : mode==="sheet" ? "Sheet Music · MusicXML"
                  : `${rootDisplay} ${scaleInfo.label} · ${mode==="scales" ? "Scale Explorer" : chordType==="9" ? "9th chords" : chordType==="7" ? "7th chords" : "Triads"}`}
              </p>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <div style={{ width:8, height:8, borderRadius:"50%", background:"#E8920C",
                boxShadow:"0 0 6px #E8920C,0 0 12px rgba(232,146,12,0.6)",
                animation:"led-glow 2s ease-in-out infinite" }} />
              <span style={{ fontSize:10, color:t.textTertiary, fontWeight:600,
                letterSpacing:"0.15em", textTransform:"uppercase", fontFamily:"'Share Tech Mono',monospace" }}>
                PWR
              </span>
            </div>
          </div>

          {/* ── Mode switcher ── */}
          <div style={{ display:"flex", gap:6, marginBottom:12, flexWrap:"wrap" }}>
            {[
              { key:"chords",  label:"Chords" },
              { key:"scales",  label:"Scale Explorer" },
              { key:"detect",  label:"Key Detector" },
              { key:"sheet",   label:"Sheet Music" },
            ].map(({ key: m, label }) => (
              <button key={m} onClick={() => setMode(m)} style={{
                fontFamily:SF, fontSize:14, fontWeight: mode===m ? 600 : 400,
                padding:"8px 20px", borderRadius:12,
                background: mode===m ? t.modeBtnActiveBg : t.modeBtnBg,
                border: mode===m ? `1px solid ${t.modeBtnActiveBorder}` : `1px solid ${t.modeBtnBorder}`,
                color: mode===m ? t.modeBtnActiveColor : t.modeBtnColor,
                cursor:"pointer", transition:"all 0.12s ease",
                boxShadow: mode===m ? t.cardShadow : "none",
              }}>
                {label}
              </button>
            ))}
          </div>

          {/* ── Controls (hidden in detect mode) ── */}
          {mode !== "detect" && <div style={card}>
            <div style={{ display:"flex", gap:20, flexWrap:"wrap", alignItems:"flex-end" }}>
              {mode !== "sheet" && <div>
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
              {mode !== "sheet" && <div>
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
                    options={[{value:"triad",label:"Triads"},{value:"7",label:"With 7ths"},{value:"9",label:"With 9ths"}]}
                    onChange={v => setChordType(v)}
                    t={t}
                  />
                </div>
              )}
              <div>
                <label style={labelStyle}>Sound</label>
                <SegmentedControl
                  value={soundType}
                  options={[{value:"piano",label:"Grand Piano"},{value:"rhodes",label:"Rhodes"}]}
                  onChange={v => setSoundType(v)}
                  t={t}
                />
              </div>

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
                        <select
                          value={midiChannel}
                          onChange={e => setMidiChannel(Number(e.target.value))}
                          style={{ ...selectStyle, width:90 }}
                        >
                          {Array.from({length:16},(_,i)=>i+1).map(ch => (
                            <option key={ch} value={ch}>Ch {ch}</option>
                          ))}
                        </select>
                      )}
                    </>
                  )}
                </div>
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
                      padding:"8px 20px", borderRadius:10, border:"none",
                      background:t.accent, color:"#FFFFFF",
                      cursor:"pointer", whiteSpace:"nowrap", flexShrink:0,
                    }}>
                    ▶  Play scale
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
                        borderRadius:10, padding:"6px 14px",
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
                <div style={{ background:t.pianoRailBg, borderRadius:12, padding:"10px 12px 12px", boxShadow:t.pianoRailShadow }}>
                  <div style={{ background:t.pianoKeysBg, borderRadius:6, overflow:"hidden" }}>
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
                          borderRadius:8, padding:"5px 14px",
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

          {/* ════════════════ CHORDS MODE ════════════════ */}
          {mode === "chords" && (
            <>
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
                        onMouseEnter={() => setHoveredChord(c)}
                        onMouseLeave={() => setHoveredChord(null)}
                        style={{
                          border: accent ? `1px solid rgba(232,146,12,0.6)` : `1px solid rgba(255,255,255,0.07)`,
                          borderRadius:10, padding:"13px 6px 11px",
                          background: isActive
                            ? "linear-gradient(180deg,rgba(232,146,12,0.18) 0%,rgba(232,146,12,0.08) 100%)"
                            : isHovered
                            ? "linear-gradient(180deg,#32363F 0%,#2A2D34 100%)"
                            : "linear-gradient(180deg,#2E3138 0%,#22252C 100%)",
                          cursor:"pointer", textAlign:"center", userSelect:"none",
                          transition:"all 0.1s ease",
                          boxShadow: accent
                            ? `0 0 12px rgba(232,146,12,0.2),inset 0 1px 0 rgba(255,255,255,0.06)`
                            : `inset 0 1px 0 rgba(255,255,255,0.05),0 2px 4px rgba(0,0,0,0.4)`,
                        }}>
                        <div style={{ fontSize:10, color:accent?t.accent:"#484540", marginBottom:4, fontWeight:700, letterSpacing:"0.12em", textTransform:"uppercase" }}>
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
                          borderRadius:8, padding:"4px 12px", fontSize:13, fontWeight:600,
                          letterSpacing:"-0.01em", fontFamily:SF,
                        }}>
                          {NOTES[ni]}
                        </span>
                      ))
                    : <span style={{ fontSize:13, color:t.textTertiary, fontFamily:SF }}>Hover over a chord to see notes</span>
                  }
                </div>

                <div style={{ background:t.pianoRailBg, borderRadius:12, padding:"10px 12px 12px", boxShadow:t.pianoRailShadow }}>
                  <div style={{ background:t.pianoKeysBg, borderRadius:6, overflow:"hidden" }}>
                    <Piano highlightedNotes={highlightedNotes} scaleNoteIndices={scaleNoteIndices} t={t} onNoteClick={note => { if (!sendMIDISingleNote(note)) playSingleNote(note, soundType); }} />
                  </div>
                </div>

                <div style={{ display:"flex", gap:16, marginTop:12, fontSize:12, color:t.textSecondary }}>
                  <span style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ width:14, height:14, borderRadius:4, background:t.legendChord, display:"inline-block", flexShrink:0 }} />
                    Chord tones
                  </span>
                  <span style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ width:14, height:14, borderRadius:4, background:t.legendScale, border:`1px solid ${t.legendScaleBdr}`, display:"inline-block", flexShrink:0 }} />
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
                          boxShadow:"0 0 0 2px rgba(48,209,88,0.3)", display:"inline-block",
                          animation:"pulse 1.2s ease-in-out infinite" }} />
                        LOOPING
                      </span>
                    )}
                  </div>
                  <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
                    {/* BPM */}
                    <span style={{ fontSize:11, fontWeight:600, color:t.labelColor, textTransform:"uppercase", letterSpacing:"0.07em" }}>BPM</span>
                    <button onClick={() => setBpm(b => Math.max(40, b-1))} style={{ fontFamily:SF, fontSize:13, fontWeight:600, width:26, height:26, borderRadius:8, border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer", lineHeight:1 }}>−</button>
                    <input type="number" min={40} max={240} value={bpm}
                      onChange={e => { const v=parseInt(e.target.value); if(!isNaN(v)&&v>=40&&v<=240) setBpm(v); else if(e.target.value==="") setBpm(e.target.value); }}
                      onBlur={e => { const v=parseInt(e.target.value); setBpm(isNaN(v)?90:Math.min(240,Math.max(40,v))); }}
                      style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:15, textAlign:"center", width:58, padding:"4px 6px", borderRadius:8, border:`1px solid rgba(232,146,12,0.3)`, background:t.inputBg, color:t.accent, colorScheme:"dark", appearance:"textfield", MozAppearance:"textfield", letterSpacing:"0.08em" }}
                    />
                    <button onClick={() => setBpm(b => Math.min(240, b+1))} style={{ fontFamily:SF, fontSize:13, fontWeight:600, width:26, height:26, borderRadius:8, border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer", lineHeight:1 }}>+</button>
                    <div style={{ width:1, height:20, background:t.border, margin:"0 2px" }} />
                    {/* Octave */}
                    <span style={{ fontSize:11, fontWeight:600, color:t.labelColor, textTransform:"uppercase", letterSpacing:"0.07em" }}>Oct</span>
                    <button onClick={() => { if(looping) stopLoop(); setChordOctave(o=>Math.max(2,o-1)); }} style={{ fontFamily:SF, fontSize:13, fontWeight:600, width:26, height:26, borderRadius:8, border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer", lineHeight:1 }}>−</button>
                    <span style={{ fontSize:14, fontWeight:700, color:t.textPrimary, minWidth:16, textAlign:"center" }}>{chordOctave}</span>
                    <button onClick={() => { if(looping) stopLoop(); setChordOctave(o=>Math.min(6,o+1)); }} style={{ fontFamily:SF, fontSize:13, fontWeight:600, width:26, height:26, borderRadius:8, border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer", lineHeight:1 }}>+</button>
                  </div>
                </div>

                {/* Timeline track */}
                <div style={{ borderRadius:10, overflow:"hidden", border:`1px solid ${t.border}`, marginBottom:12 }}>
                  {/* Bar labels */}
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(8,1fr)", background:t.elevatedBg, borderBottom:`1px solid ${t.border}` }}>
                    {Array.from({length:8}, (_,i) => (
                      <div key={i} style={{ padding:"4px 6px", borderLeft: i>0 ? `1px solid ${i%2===0 ? t.border : "rgba(255,255,255,0.03)"}` : "none" }}>
                        {i%2===0 && <span style={{ fontSize:9, fontWeight:700, color:t.textTertiary, letterSpacing:"0.08em", textTransform:"uppercase" }}>Bar {i/2+1}</span>}
                      </div>
                    ))}
                  </div>
                  {/* Track area */}
                  <div ref={trackRef} style={{ position:"relative", height:76, background:t.slotBg, userSelect:"none" }}>
                    {/* Slot lines */}
                    {Array.from({length:8}, (_,i) => i>0 && (
                      <div key={i} style={{ position:"absolute", left:`${i/8*100}%`, top:0, bottom:0, width:1, background: i%2===0 ? t.border : "rgba(255,255,255,0.03)", pointerEvents:"none" }} />
                    ))}
                    {/* Chord blocks */}
                    {timelineItems.map(item => (
                      <div key={item.id}
                        onMouseDown={e => { if(e.target.dataset.resize) return; e.preventDefault(); dragRef.current={type:"move",id:item.id,startX:e.clientX,origStart:item.startSlot,origLength:item.lengthSlots}; }}
                        style={{
                          position:"absolute",
                          left:`${(item.startSlot/8)*100}%`,
                          width:`calc(${(item.lengthSlots/8)*100}% - 4px)`,
                          top:6, height:"calc(100% - 12px)",
                          background:`linear-gradient(180deg,${t.accentCardHover} 0%,${t.accentCardBg} 100%)`,
                          border:`1px solid ${t.accentBorder}`,
                          borderRadius:6, cursor:"grab",
                          display:"flex", alignItems:"center", justifyContent:"space-between",
                          padding:"0 4px 0 8px", overflow:"hidden",
                          boxShadow:`0 0 8px rgba(232,146,12,0.1)`,
                        }}>
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
                    ))}
                    {/* Playhead */}
                    {looping && (
                      <div style={{ position:"absolute", left:`${playheadPct*100}%`, top:0, bottom:0, width:2, background:t.accent, opacity:0.9, pointerEvents:"none", boxShadow:`0 0 6px ${t.accent}` }} />
                    )}
                    {/* Empty state */}
                    {timelineItems.length===0 && (
                      <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                        <span style={{ fontSize:13, color:t.textTertiary, fontFamily:SF }}>Klikk en akkord i rutenettet over for å legge den til ↑</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Controls */}
                <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
                  <button onClick={playTimeline} disabled={timelineItems.length===0}
                    style={{ fontFamily:SF, fontSize:13, fontWeight:600, padding:"8px 20px", borderRadius:10, border:"none",
                      background: timelineItems.length===0 ? t.playDisabledBg : looping ? "#FF453A" : t.playActiveBg,
                      color: timelineItems.length===0 ? t.playDisabledClr : "#FFFFFF",
                      cursor: timelineItems.length===0 ? "not-allowed" : "pointer", transition:"all 0.15s ease" }}>
                    {looping ? "⬛ Stop" : "▶  Play"}
                  </button>
                  <button onClick={() => { if(looping) stopLoop(); setArpOn(a=>!a); }}
                    style={{ fontFamily:SF, fontSize:13, fontWeight:600, padding:"8px 18px", borderRadius:10,
                      border:`1px solid ${arpOn?t.accentBorder:t.btnBorder}`, background:arpOn?t.accentBg:t.btnBg,
                      color:arpOn?t.accent:t.btnColor, cursor:"pointer", transition:"all 0.15s ease" }}>
                    ⤴ Arp
                  </button>
                  {arpOn && <>
                    <div style={{ width:1, height:20, background:t.border }} />
                    {[{v:"up",l:"↑"},{v:"down",l:"↓"},{v:"updown",l:"↑↓"},{v:"random",l:"?"}].map(({v,l}) => (
                      <button key={v} onClick={() => { if(looping) stopLoop(); setArpPattern(v); }}
                        style={{ fontFamily:SF, fontSize:12, fontWeight:arpPattern===v?700:500, padding:"5px 11px", borderRadius:8,
                          border:`1px solid ${arpPattern===v?t.accentBorder:t.btnBorder}`, background:arpPattern===v?t.accentBg:t.btnBg,
                          color:arpPattern===v?t.accent:t.btnColor, cursor:"pointer" }}>{l}</button>
                    ))}
                    <div style={{ width:1, height:20, background:t.border }} />
                    {[{v:0.25,l:"16th"},{v:0.5,l:"8th"},{v:1,l:"¼"}].map(({v,l}) => (
                      <button key={v} onClick={() => { if(looping) stopLoop(); setArpRate(v); }}
                        style={{ fontFamily:SF, fontSize:12, fontWeight:arpRate===v?700:500, padding:"5px 11px", borderRadius:8,
                          border:`1px solid ${arpRate===v?t.accentBorder:t.btnBorder}`, background:arpRate===v?t.accentBg:t.btnBg,
                          color:arpRate===v?t.accent:t.btnColor, cursor:"pointer" }}>{l}</button>
                    ))}
                  </>}
                  <div style={{ width:1, height:20, background:t.border }} />
                  <button onClick={() => { stopLoop(); setTimelineItems([]); setActiveChord(null); }}
                    style={{ fontFamily:SF, fontSize:13, fontWeight:500, padding:"8px 18px", borderRadius:10, border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer" }}>
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
                      const len2 = Math.min(2, TIMELINE_SLOTS - slot);
                      items.push({ id: Date.now()+Math.random(), chord, startSlot:slot, lengthSlots:len2 });
                      slot += len2;
                    });
                    setTimelineItems(items); setActiveChord(cs[0]);
                  }} style={{ fontFamily:SF, fontSize:13, fontWeight:500, padding:"8px 18px", borderRadius:10, border:`1px solid ${t.btnBorder}`, background:t.btnBg, color:t.btnColor, cursor:"pointer" }}>
                    Random
                  </button>
                  <button onClick={() => {
                    stopLoop();
                    const pick = FAMOUS_PROGRESSIONS[Math.floor(Math.random()*FAMOUS_PROGRESSIONS.length)];
                    const cs = pick.degrees.map(d => chords[d%7]);
                    let slot = 0;
                    const items = [];
                    cs.forEach(chord => {
                      if (slot >= TIMELINE_SLOTS) return;
                      const len2 = Math.min(2, TIMELINE_SLOTS - slot);
                      items.push({ id: Date.now()+Math.random(), chord, startSlot:slot, lengthSlots:len2 });
                      slot += len2;
                    });
                    setTimelineItems(items); setActiveChord(cs[0]);
                  }} style={{ fontFamily:SF, fontSize:13, fontWeight:600, padding:"8px 18px", borderRadius:10, border:`1px solid ${t.accentBorder}`, background:t.accentBg, color:t.accent, cursor:"pointer" }}>
                    ✦ Suggest
                  </button>
                  <div style={{ width:1, height:20, background:t.border }} />
                  {/* Chord text input */}
                  <input value={chordInput} onChange={e=>{setChordInput(e.target.value);setChordInputErr(false);}}
                    onKeyDown={e=>{ if(e.key!=="Enter") return; const c=parseChordText(chordInput); if(!c){setChordInputErr(true);return;} addChord(c); setChordInput(""); }}
                    placeholder="Skriv akkord, f.eks. Fmaj7…"
                    style={{ fontFamily:SF, fontSize:13, padding:"7px 12px", borderRadius:10, border:`1.5px solid ${chordInputErr?"#FF453A":t.inputBorder}`, background:t.inputBg, color:t.inputColor, outline:"none", width:180 }}
                  />
                  <button onClick={() => { const c=parseChordText(chordInput); if(!c){setChordInputErr(true);return;} addChord(c); setChordInput(""); }}
                    style={{ fontFamily:SF, fontSize:13, fontWeight:600, padding:"7px 16px", borderRadius:10, border:"none", background:t.accent, color:"#FFFFFF", cursor:"pointer" }}>
                    Add
                  </button>
                  {chordInputErr && <span style={{ fontSize:12, color:"#FF453A", fontFamily:SF }}>Ukjent akkord</span>}
                </div>
              </div>
            </>
          )}

        </div>
      </div>
    </>
  );
}
