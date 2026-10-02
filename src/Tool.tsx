// Echoform: turns a long episode transcript into a week of clips, ranked by replays or by how quotable each moment is.
import { useMemo, useState } from "react";
import { csvObjects, num } from "./lib/csv";
import { addDays, todayISO, prettyDate } from "./lib/time";
import { useCopy, useStored, download } from "./lib/store";
import { Section, ImportBox, Stats, Stat } from "./ui/kit";

const T = "echoform";
type Line = { t: number; text: string };
type Clip = { start: number; end: number; text: string; score: number; why: string[] };

const SAMPLE = `[00:00:05] Welcome back to Small Shop Stories. Today I'm talking to Hana, who runs a ceramics studio in Nabeul.
[00:00:40] So Hana, how did the studio start?
[00:01:02] Honestly it started with a broken kiln and a loan from my aunt. I had 300 dinars and no plan.
[00:02:15] The first year we sold almost nothing online. Then one video of a glaze test got 2 million views.
[00:03:30] Why did that video work? Because people love watching something go wrong and then go right.
[00:04:45] My biggest mistake was pricing. I charged 15 dinars for a mug that took 4 hours to make.
[00:06:10] Now the rule is simple: materials times three, plus my hourly rate. Never below that.
[00:07:20] Do you ever feel like giving up? Every single February. February is the worst month for a potter.
[00:08:55] The secret nobody tells you is that wholesale saved us. Two hotels ordering 200 plates beats 1,000 Instagram likes.
[00:10:30] If you are starting today, make ten things and sell ten things before you build a website.
[00:12:00] Thanks for listening. Find Hana's studio on Instagram.`;

const parseTs = (s: string) => s.split(":").map(Number).reduce((a, b) => a * 60 + b, 0);
const fmt = (sec: number) => { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60); return (h ? `${h}:` : "") + `${String(m).padStart(h ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`; };

function parseTranscript(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*\[?((?:\d{1,2}:)?\d{1,2}:\d{2})(?:[.,]\d+)?\]?\s*[-–:]?\s*(.*)$/);
    if (m && m[2].trim()) out.push({ t: parseTs(m[1]), text: m[2].trim() });
    else if (raw.trim() && out.length) out[out.length - 1].text += " " + raw.trim();
  }
  return out;
}

/** Quotability heuristics used when no replay data is available. */
function textScore(t: string): [number, string[]] {
  const why: string[] = []; let s = 0;
  if (/\d/.test(t)) { s += 2; why.push("has a number"); }
  if (/\?/.test(t)) { s += 1.5; why.push("asks a question"); }
  if (/\b(secret|mistake|never|always|nobody|biggest|worst|best|rule|truth|honestly|if you)\b/i.test(t)) { s += 3; why.push("strong claim"); }
  if (/\b(because|so that|the reason)\b/i.test(t)) { s += 1; why.push("explains why"); }
  const words = t.split(/\s+/).length;
  if (words >= 12 && words <= 45) { s += 2; why.push("good length"); }
  if (/^(so|and|but|um|uh|yeah)\b/i.test(t)) s -= 1;
  if (/\b(welcome|thanks for listening|subscribe)\b/i.test(t)) s -= 4;
  return [s, why];
}

export default function Echoform() {
  const [transcript, setTranscript] = useStored(T, "transcript", SAMPLE);
  const [replays, setReplays] = useStored<{ t: number; n: number }[]>(T, "replays", []);
  const [clipLen, setClipLen] = useStored(T, "clipLen", 45);
  const [start, setStart] = useStored(T, "start", todayISO());
  const [perWeek, setPerWeek] = useStored(T, "perWeek", 7);
  const [picked, setPicked] = useState<number | null>(null);
  const { copy, copied } = useCopy();

  const lines = useMemo(() => parseTranscript(transcript), [transcript]);
  const clips = useMemo<Clip[]>(() => {
    const maxT = replays.length ? Math.max(...replays.map(r => r.n)) : 0;
    return lines.map((l, i) => {
      let end = l.t, text = l.text, j = i;
      while (j + 1 < lines.length && lines[j + 1].t - l.t < clipLen) { j++; text += " " + lines[j].text; }
      end = Math.max(l.t + 15, Math.min(l.t + clipLen, j + 1 < lines.length ? lines[j + 1].t : l.t + clipLen));
      const [ts, why] = textScore(l.text);
      let s = ts;
      if (maxT) {
        const inWin = replays.filter(r => r.t >= l.t && r.t < end);
        const avg = inWin.length ? inWin.reduce((a, r) => a + r.n, 0) / inWin.length : 0;
        s = (avg / maxT) * 10 + ts * 0.3;
        if (avg) why.unshift(`replayed ${Math.round((avg / maxT) * 100)}% of peak`);
      }
      return { start: l.t, end, text, score: s, why };
    }).sort((a, b) => b.score - a.score)
      .filter((c, i, arr) => arr.slice(0, i).every(o => c.end <= o.start || c.start >= o.end)) // no overlaps
      .slice(0, perWeek);
  }, [lines, replays, clipLen, perWeek]);

  const schedule = clips.map((c, i) => ({ ...c, date: addDays(start, Math.floor((i * 7) / perWeek)) }));
  const caption = (c: Clip) => {
    const first = c.text.split(/(?<=[.?!])\s/)[0];
    return `${first.length > 140 ? first.slice(0, 137) + "…" : first}\n\nFull episode at the link in bio.`;
  };
  const exportCsv = () => download("echoform-clips.csv", ["Date,Start,End,Caption", ...schedule.map(c => `${c.date},${fmt(c.start)},${fmt(c.end)},"${caption(c).replace(/"/g, '""').replace(/\n/g, " ")}"`)].join("\n"), "text/csv");

  return (
    <div className="stack">
      <div className="grid2">
        <Section title="Episode transcript">
          <label className="field"><span>Paste a transcript with timestamps like [00:12:30]</span>
            <textarea id="ef-tr" className="input" rows={10} value={transcript} onChange={e => setTranscript(e.target.value)} style={{ fontSize: 14 }} />
          </label>
          <p className="note" style={{ marginTop: 8 }}>{lines.length} timestamped lines found. Most podcast hosts and YouTube export transcripts in this format.</p>
        </Section>
        <div className="stack">
          <Section title="Listener replays (optional)">
            <ImportBox label="CSV with a time and a replay count per moment" placeholder={"time,replays\n00:01:00,120\n00:04:45,480"} rows={4}
              onText={t => setReplays(csvObjects(t).map(r => { const v = Object.values(r); return { t: String(v[0]).includes(":") ? parseTs(String(v[0])) : num(v[0]), n: num(v[1]) }; }).filter(r => r.n > 0))} />
            <p className="note" style={{ marginTop: 8 }}>{replays.length ? `${replays.length} replay points loaded. Clips are ranked by replays first.` : "Without replay data, clips are ranked by how quotable they are."}</p>
            {replays.length > 0 && <button className="btn ghost small" onClick={() => setReplays([])}>Remove replay data</button>}
          </Section>
          <Section title="Plan">
            <div className="row">
              <label className="field"><span>Clip length (sec)</span><input id="ef-len" type="number" min={15} max={180} className="input num" value={clipLen} onChange={e => setClipLen(Math.max(15, +e.target.value || 45))} /></label>
              <label className="field"><span>Clips</span><input id="ef-n" type="number" min={1} max={21} className="input num" value={perWeek} onChange={e => setPerWeek(Math.max(1, Math.min(21, +e.target.value || 7)))} /></label>
              <label className="field"><span>Start on</span><input id="ef-start" type="date" className="input" value={start} onChange={e => setStart(e.target.value)} /></label>
            </div>
          </Section>
        </div>
      </div>

      <Section title="Your clip week" aside={<button className="btn small" onClick={exportCsv} disabled={!schedule.length}>Export CSV</button>}>
        <Stats><Stat value={schedule.length} label="Clips" /><Stat value={fmt(schedule.reduce((a, c) => a + c.end - c.start, 0))} label="Total clip time" /><Stat value={lines.length ? fmt(lines[lines.length - 1].t) : "0:00"} label="Episode length" /></Stats>
        <div className="stack" style={{ gap: 12, marginTop: 18 }}>
          {schedule.length === 0 && <p className="empty-note">Paste a transcript with timestamps to get clips.</p>}
          {schedule.map((c, i) => (
            <div key={i} className="ef-clip">
              <div className="ef-when"><strong>{prettyDate(c.date)}</strong><span className="num">{fmt(c.start)} to {fmt(c.end)}</span></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p>{c.text}</p>
                <div className="row" style={{ gap: 6, marginTop: 6 }}>{c.why.map(w => <span key={w} className="pill">{w}</span>)}</div>
                {picked === i && <pre className="ef-cap">{caption(c)}</pre>}
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <button className="btn small" onClick={() => setPicked(picked === i ? null : i)}>{picked === i ? "Hide caption" : "Caption"}</button>
                <button className="btn ghost small" onClick={() => copy(caption(c))}>{copied ? "Copied" : "Copy caption"}</button>
              </div>
            </div>
          ))}
        </div>
      </Section>
      <style>{`.ef-clip{display:flex;gap:16px;align-items:flex-start;padding-top:12px;border-top:1px solid var(--line);flex-wrap:wrap}.ef-when{display:flex;flex-direction:column;min-width:120px}.ef-when strong{font-family:var(--serif);font-weight:400;font-size:20px}.ef-when span{font-family:var(--mono);font-size:12px;color:var(--muted)}.ef-cap{white-space:pre-wrap;font-family:var(--sans);background:var(--sunk);padding:10px;border-radius:8px;margin:8px 0 0;font-size:14px}`}</style>
    </div>
  );
}
