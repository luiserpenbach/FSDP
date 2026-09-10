/**
 * Project tag scheme editor (Settings page): simple `HV-12` or structured
 * `PT 3222` tags with system and class digit tables and function letters.
 */
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { FormError, Panel } from "../components/ui";
import { DEFAULT_TAG_SCHEME, REFERENCE_TAG_SCHEME, normalizeScheme, type TagScheme } from "../engine/tags";
import type { Project } from "../types";

function linesToPairs(text: string): Array<[string, string]> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [key, ...rest] = line.split("=");
      return [key.trim(), rest.join("=").trim()] as [string, string];
    })
    .filter(([key]) => key);
}

function pairsToLines(entries: Array<{ [key: string]: string }>, keyField: string, valueField: string): string {
  return entries.map((entry) => `${entry[keyField]}=${entry[valueField]}`).join("\n");
}

export function TagSchemePanel({ project, canWrite }: { project: Project | null; canWrite: boolean }) {
  const [scheme, setScheme] = useState<TagScheme>(DEFAULT_TAG_SCHEME);
  const [systemsText, setSystemsText] = useState("");
  const [classesText, setClassesText] = useState("");
  const [lettersText, setLettersText] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function load(next: TagScheme) {
    setScheme(next);
    setSystemsText(pairsToLines(next.systems, "digit", "name"));
    setClassesText(pairsToLines(next.classes, "digit", "name"));
    setLettersText(pairsToLines(next.functionLetters, "letters", "description"));
  }

  useEffect(() => {
    if (!project) return;
    setStatus("");
    setError("");
    void api
      .getTagScheme(project.id)
      .then((read) => load(normalizeScheme(read.scheme)))
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load the tag scheme."));
  }, [project]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!project) return;
    setBusy(true);
    setError("");
    try {
      const next: TagScheme = {
        ...scheme,
        systems: linesToPairs(systemsText).map(([digit, name]) => ({ digit, name })),
        classes: linesToPairs(classesText).map(([digit, name]) => ({ digit, name })),
        functionLetters: linesToPairs(lettersText).map(([letters, description]) => ({ letters: letters.toUpperCase(), description }))
      };
      const saved = await api.updateTagScheme(project.id, next);
      load(normalizeScheme(saved.scheme));
      setStatus("Tag scheme saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the tag scheme.");
    } finally {
      setBusy(false);
    }
  }

  if (!project) {
    return (
      <Panel title="Tag Scheme">
        <p className="hint">Select a project to configure how component tags are numbered.</p>
      </Panel>
    );
  }

  const example = scheme.kind === "structured" ? `PT${scheme.separator}${scheme.systems[0]?.digit ?? "3"}${scheme.classes[0]?.digit ?? "2"}${"1".padStart(scheme.sequenceLength, "0")}` : `HV${scheme.separator}${"1".padStart(scheme.sequenceLength, "0")}`;

  return (
    <Panel title={`Tag Scheme · ${project.name}`}>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          Structure
          <select value={scheme.kind} onChange={(event) => setScheme({ ...scheme, kind: event.target.value as TagScheme["kind"] })} disabled={!canWrite}>
            <option value="simple">Simple: letters + sequence (HV-12)</option>
            <option value="structured">Structured: letters + system digit + class digit + sequence (PT 3222)</option>
          </select>
        </label>
        <div className="fieldRow">
          <label>
            Separator
            <select value={scheme.separator} onChange={(event) => setScheme({ ...scheme, separator: event.target.value })} disabled={!canWrite}>
              <option value="-">Hyphen (HV-12)</option>
              <option value=" ">Space (HV 12)</option>
              <option value="">None (HV12)</option>
            </select>
          </label>
          <label>
            Sequence digits
            <input type="number" min={1} max={6} value={scheme.sequenceLength} onChange={(event) => setScheme({ ...scheme, sequenceLength: Math.max(1, Math.min(6, Number(event.target.value) || 1)) })} disabled={!canWrite} />
          </label>
        </div>
        <label className="checkRow">
          <input type="checkbox" checked={scheme.strictLetters} onChange={(event) => setScheme({ ...scheme, strictLetters: event.target.checked })} disabled={!canWrite} />
          <span>Only allow function letters from the table below</span>
        </label>
        {scheme.kind === "structured" && (
          <div className="fieldRow">
            <label>
              System digits (digit=name per line)
              <textarea value={systemsText} onChange={(event) => setSystemsText(event.target.value)} rows={4} disabled={!canWrite} />
            </label>
            <label>
              Class digits (digit=name per line)
              <textarea value={classesText} onChange={(event) => setClassesText(event.target.value)} rows={4} disabled={!canWrite} />
            </label>
          </div>
        )}
        <label>
          Function letters (LETTERS=description per line)
          <textarea value={lettersText} onChange={(event) => setLettersText(event.target.value)} rows={6} disabled={!canWrite} />
        </label>
        <p className="hint">
          Example tag: <span className="mono">{example}</span>
        </p>
        <FormError message={error} />
        <div className="buttonRow">
          <button type="submit" className="primary" disabled={!canWrite || busy}>
            Save tag scheme
          </button>
          <button type="button" disabled={!canWrite} onClick={() => load(REFERENCE_TAG_SCHEME)}>
            Load reference scheme (PT 3222)
          </button>
          <button type="button" disabled={!canWrite} onClick={() => load(DEFAULT_TAG_SCHEME)}>
            Reset to simple
          </button>
        </div>
        {status && <p className="hint">{status}</p>}
      </form>
    </Panel>
  );
}
