import { useCallback, useEffect, useState } from "react";
import type { ProjectRecord, ProjectStore } from "./backend/types";
import { App, type AppProps } from "./App";
import { ProjectsHome } from "./screens/Projects";

/** The portal: the projects home, and a project opened from it. The open project is in the URL (#/p/<id>), so a reload or a link comes back to it. */
export function Portal(props: Omit<AppProps, "project" | "projectStore" | "onHome"> & { projects: ProjectStore }) {
  const [list, setList] = useState<ProjectRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ProjectRecord | null>(null);
  const live = props.backend.mode === "live";

  const reload = useCallback(async () => {
    try { const l = await props.projects.list(); setList(l); setError(null); return l; }
    catch (e) { setError(`Your projects could not be loaded: ${(e as Error).message}`); setList([]); return []; }
  }, [props.projects]);

  const openRec = (r: ProjectRecord | null) => {
    setOpen(r);
    // A new entry, so the browser's Back from a project comes home, and from home goes back into the project.
    history.pushState(null, "", r ? `${location.pathname}${location.search}#/p/${r.id}` : `${location.pathname}${location.search}`);
    window.scrollTo(0, 0);
  };

  useEffect(() => {
    const onPop = () => {
      const m = location.hash.match(/^#\/p\/([\w-]+)$/);
      if (!m) { setOpen(null); void reload(); return; }
      setOpen((cur) => (cur?.id === m[1] ? cur : null));
      if (!open || open.id !== m[1]) void reload().then((l) => { const hit = l.find((r) => r.id === m[1]); if (hit) setOpen(hit); });
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, [reload, open]);

  useEffect(() => {
    void reload().then((l) => { const m = location.hash.match(/^#\/p\/([\w-]+)$/); const hit = m && l.find((r) => r.id === m[1]); if (hit) setOpen(hit); });
  }, [reload]);

  if (open) return <App key={open.id} {...props} project={open} projectStore={props.projects} onHome={() => { openRec(null); void reload(); }} />;
  return (
    <ProjectsHome projects={list} error={error} live={live} user={props.user ?? null} siteLabel={props.jira.site || "Jira"} onSignOut={props.onSignOut}
      onOpen={openRec}
      onCreate={async () => { try { openRec(await props.projects.create("Untitled project", { events: [{ at: new Date().toISOString(), text: "Project created" }] })); } catch (e) { setError(`The project could not be created: ${(e as Error).message}`); } }}
      onDelete={async (r) => { try { await props.projects.remove(r.id); await reload(); } catch (e) { setError(`${r.name} could not be deleted: ${(e as Error).message}`); } }} />
  );
}
