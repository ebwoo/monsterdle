// Shared by the website and the server, so both read monsters.json the same way.

// "audio/Pale_Crawler.mp3" -> "Pale Crawler"
export const nameFromFile = (path) =>
  path.split("/").pop().replace(/\.[^.]+$/, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();

const DEFAULT_MODES = {
  spawn: { label: "Spawn Sound", description: "", start: "beginning", steps: [0.5, 1, 2, 3, 5, 8] },
  theme: { label: "Theme", description: "", start: "random", steps: [1, 2, 4, 7, 11, 16] },
};

// Cleans up a raw monsters.json: fills in names from file names, accepts older
// formats ("spawn"/"theme" instead of "audio"), and drops modes without clip lengths.
export function normalizeConfig(raw) {
  const monsters = (raw.monsters || []).flatMap((m) => {
    const entry = typeof m === "string" ? { audio: m } : { ...m };
    entry.audio ||= entry.spawn || entry.theme;
    if (!entry.audio) return [];
    return [{ ...entry, name: entry.name || nameFromFile(entry.audio), aliases: entry.aliases || [] }];
  });
  let modes = Object.fromEntries(Object.entries(raw.modes || {})
    .filter(([, m]) => m && Array.isArray(m.steps) && m.steps.length > 0)
    .map(([key, m]) => [key, { ...m, label: m.label || key }]));
  if (!Object.keys(modes).length) modes = DEFAULT_MODES;
  return { title: raw.title || "Monsterdle", modes, monsters };
}

// "beginning" plays from 0:00; "random" plays from anywhere in the file.
// Modes without a "start" setting: the first one plays from the beginning, the rest are random.
export function startStyle(config, key) {
  const start = config.modes[key].start;
  if (start === "beginning" || start === "random") return start;
  return Object.keys(config.modes)[0] === key ? "beginning" : "random";
}
