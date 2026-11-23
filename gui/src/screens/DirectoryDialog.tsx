import { useState } from "react";

/** The read-only consent for the employee directory, used on Get started (first) and again on Connect apps. */
export const DIRECTORY_SCOPES = ["Read names, titles, teams and reporting lines"];

export function Scopes({ can, cannot }: { can: string[]; cannot: string[] }) {
  return (
    <div className="stack-sm sm">
      <span style={{ fontWeight: 500 }}>It will be able to</span>
      <ul className="list">{can.map((s) => <li key={s}>{s}</li>)}</ul>
      <span style={{ fontWeight: 500, marginTop: 4 }}>It won't be able to</span>
      <ul className="list">{cannot.map((s) => <li key={s}>{s}</li>)}</ul>
    </div>
  );
}

interface Props { live: boolean; onAccept: (file: File | null) => void; onCancel: () => void }

export function DirectoryDialog(p: Props) {
  const [dirFile, setDirFile] = useState<File | null>(null);
  return (
    <div className="consent accent" role="dialog" aria-labelledby="dir-title">
      <span className="eyebrow">Employee directory · {p.live ? "from a file" : "sample sign-in"}</span>
      <h2 id="dir-title">Throughline wants read-only access to your employee directory</h2>
      {p.live ? (
        <div className="stack-sm" style={{ gap: 4, maxWidth: 420 }}>
          <label htmlFor="directory-file" className="label">Directory export (a team list or org chart: YAML, CSV or spreadsheet)</label>
          <input id="directory-file" type="file" className="input" style={{ padding: "9px 12px" }} onChange={(e) => setDirFile(e.target.files?.[0] ?? null)} />
          <span className="small muted">No directory connector exists yet: an export stands in for it, and is read the same way as a team list.</span>
        </div>
      ) : (
        <div className="stack-sm" style={{ gap: 4 }}><span className="label">Source</span><span className="sm">Sample directory (the sample team list)</span></div>
      )}
      <Scopes can={DIRECTORY_SCOPES} cannot={["Create, edit, delete or comment on anything"]} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <button type="button" className="btn primary" disabled={p.live && !dirFile} onClick={() => p.onAccept(p.live ? dirFile : null)}>Accept</button>
        <button type="button" className="btn" onClick={p.onCancel}>Cancel</button>
      </div>
    </div>
  );
}
