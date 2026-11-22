import { useEffect, useRef, useState } from "react";
import { Info } from "./Info";

/**
 * Adding a launch checklist (or plan of record) once the project is reviewed: a dialog over the project, not the files page. The files are
 * held here until "Read", so the review underneath stays as it is if the person cancels; reading them runs the launch check
 * (or opens what it still needs, like each team's Jira project).
 */
interface Props {
  agentName: string | null;
  /** What is happening once the files are handed over: reading them, then getting the launch check ready. */
  busy: string | null;
  error: string | null;
  onRead: (picked: { files: File[]; sample: boolean }) => void;
  onClose: () => void;
}

export function PlanOfRecordDialog(p: Props) {
  const [files, setFiles] = useState<File[]>([]);
  const [sample, setSample] = useState(false);
  const [over, setOver] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !p.busy) p.onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p.busy, p.onClose]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = (list: FileList | null) => { if (list?.length) setFiles((cur) => [...cur, ...Array.from(list)]); };
  const names = [...(sample ? ["Sample launch documents"] : []), ...files.map((f) => f.name)];

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !p.busy) p.onClose(); }}>
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="por-title" data-testid="por-dialog">
        <div className="between" style={{ gap: 12, alignItems: "baseline" }}>
          <h2 id="por-title" className="h3" tabIndex={-1} ref={title} style={{ outline: "none" }}>
            Add a launch checklist<Info>A plan of record, launch checklist or readiness doc: anything that lists what's due before launch. Each item is then checked against Jira by its own date.</Info>
          </h2>
          {!p.busy && <button type="button" className="linkbtn" aria-label="Close" onClick={p.onClose}>✕</button>}
        </div>
        {p.busy ? (
          <p className="sm muted" role="status" aria-live="polite" style={{ margin: 0 }} data-testid="por-busy">{p.busy}</p>
        ) : (
          <>
            <div className={"drop compact" + (over ? " over" : "")}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer?.files ?? null); }}>
              <span className="stack-sm" style={{ gap: 2, textAlign: "left" }}>
                <span style={{ fontWeight: 500 }}>Drop files here</span>
                <span className="small muted">Any format</span>
              </span>
              <label htmlFor="por-files" className="btn" style={{ cursor: "pointer", flex: "none" }}>Choose files</label>
              <input id="por-files" className="sr-only" type="file" multiple onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
            </div>
            {names.length > 0 ? (
              <ul className="list sm" style={{ margin: 0, padding: 0, listStyle: "none" }} data-testid="por-picked">
                {sample && <li className="between" style={{ gap: 8 }}><span>Sample launch documents</span><button type="button" className="linkbtn" onClick={() => setSample(false)}>Remove</button></li>}
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="between" style={{ gap: 8 }}><span style={{ overflowWrap: "anywhere" }}>{f.name}</span>
                    <button type="button" className="linkbtn" onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>Remove</button></li>
                ))}
              </ul>
            ) : (
              <span className="small muted">Or try <button type="button" className="linkbtn" onClick={() => setSample(true)}>the sample launch documents</button></span>
            )}
            {p.error && <p className="sm warn" role="alert" style={{ margin: 0 }}>{p.error}</p>}
            <div className="row" style={{ gap: 10, justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={p.onClose}>Cancel</button>
              <button type="button" className="btn primary" disabled={!names.length} data-testid="por-read" onClick={() => p.onRead({ files, sample })}>
                {p.agentName ? `Read with ${p.agentName}` : "Read"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
