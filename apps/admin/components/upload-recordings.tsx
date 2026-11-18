"use client";

import { useRef, useState } from "react";
import { CheckCircle2, CircleAlert, FileAudio, Loader2, Upload, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { isProvider, useMe } from "@/lib/me";
import type { Options } from "@/lib/types";
import { Button, Field, Modal, Select, useLoad } from "@/components/ui";

type Result =
  | { state: "uploading" }
  | { state: "matched"; leadRef: string }
  | { state: "not_matched" }
  | { state: "duplicate" }
  | { state: "rejected"; reason: string }
  | { state: "error"; message: string };

const REASON: Record<string, string> = {
  content_does_not_match_type: "The file is not real audio of the stated type.",
  file_too_large: "The file is larger than the size limit.",
  invalid_file_name_or_type: "Use mp3, wav, m4a or ogg, with letters, digits, . _ - in the name.",
  empty_file: "The file is empty.",
};

const MAX_MB = 50;

/** Upload consent recordings in the portal: the same checks and matching as an SFTP upload. */
export function UploadRecordings({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const provider = isProvider(me);
  const options = useLoad(
    () => (provider ? Promise.resolve(null) : api.get<Options>("/options")),
    [provider],
  );
  const [platform, setPlatform] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function uploadAll() {
    setBusy(true);
    for (const file of files) {
      setResults((r) => ({ ...r, [file.name]: { state: "uploading" } }));
      let result: Result;
      if (file.size > MAX_MB * 1024 * 1024) {
        result = { state: "rejected", reason: "file_too_large" };
      } else {
        try {
          const qs = new URLSearchParams({ filename: file.name });
          if (!provider) qs.set("platform", platform);
          const res = await fetch(`/admin-api/recordings/upload?${qs}`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/octet-stream", "x-lim-admin": "1" },
            body: file,
          });
          const body = (await res.json().catch(() => ({}))) as {
            result?: string;
            lead_ref?: string;
            reason?: string;
            title?: string;
          };
          result =
            body.result === "matched"
              ? { state: "matched", leadRef: body.lead_ref ?? "" }
              : body.result === "not_matched"
                ? { state: "not_matched" }
                : body.result === "duplicate"
                  ? { state: "duplicate" }
                  : body.result === "rejected"
                    ? { state: "rejected", reason: body.reason ?? "" }
                    : { state: "error", message: body.title ?? `Upload failed (${res.status})` };
        } catch {
          result = { state: "error", message: "Upload failed. Check your connection and retry." };
        }
      }
      setResults((r) => ({ ...r, [file.name]: result }));
    }
    setBusy(false);
    onDone();
  }

  const done = files.length > 0 && files.every((f) => results[f.name]?.state !== undefined);
  const needSource = !provider && !platform;

  return (
    <Modal
      title="Upload consent recordings"
      description="Each file is checked, stored encrypted and matched to its lead automatically."
      onClose={busy ? () => {} : onClose}
    >
      <div className="space-y-4">
        {!provider && (
          <Field label="Lead source">
            <Select value={platform} onChange={(e) => setPlatform(e.target.value)} disabled={busy}>
              <option value="">Choose a source…</option>
              {options.data?.sources
                .filter((s) => s.status === "active")
                .map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name} ({s.code})
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <div
          className="rounded-xl border-2 border-dashed border-slate-200 p-5 text-center"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (!busy) setFiles([...e.dataTransfer.files]);
          }}
        >
          <FileAudio className="mx-auto h-8 w-8 text-slate-400" />
          <p className="mt-2 text-sm text-slate-600">Drag recordings here, or</p>
          <Button
            className="mt-2"
            size="sm"
            variant="secondary"
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            Choose files
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            accept=".wav,.mp3,.m4a,.ogg,audio/*"
            className="hidden"
            onChange={(e) => {
              setFiles([...(e.target.files ?? [])]);
              setResults({});
            }}
          />
          <p className="mt-2 text-xs text-slate-500">
            Name each file after the recording reference sent with the lead, e.g.{" "}
            <code>TRX-123.wav</code>. mp3, wav, m4a or ogg, up to {MAX_MB} MB.
          </p>
        </div>

        {files.length > 0 && (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {files.map((f) => (
              <li key={f.name} className="flex items-start gap-3 px-3 py-2 text-sm">
                <ResultIcon result={results[f.name]} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-slate-900">{f.name}</div>
                  <div className="text-xs text-slate-500">
                    <ResultText result={results[f.name]} size={f.size} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {done ? "Close" : "Cancel"}
          </Button>
          {!done && (
            <Button
              icon={Upload}
              loading={busy}
              disabled={files.length === 0 || needSource}
              onClick={uploadAll}
            >
              Upload {files.length > 1 ? `${files.length} files` : "file"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ResultIcon({ result }: { result?: Result }) {
  if (!result) return <FileAudio className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />;
  if (result.state === "uploading")
    return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-slate-500" />;
  if (result.state === "matched")
    return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />;
  if (result.state === "rejected" || result.state === "error")
    return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />;
  return <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />;
}

function ResultText({ result, size }: { result?: Result; size: number }) {
  const kb = `${Math.max(1, Math.round(size / 1024))} KB`;
  if (!result) return <>{kb} · ready to upload</>;
  switch (result.state) {
    case "uploading":
      return <>Uploading…</>;
    case "matched":
      return <>Uploaded and matched to lead {result.leadRef}</>;
    case "not_matched":
      return (
        <>Uploaded, but no lead with this reference yet. It is matched when the lead arrives.</>
      );
    case "duplicate":
      return <>Already received earlier (same file).</>;
    case "rejected":
      return <>Rejected: {REASON[result.reason] ?? result.reason}</>;
    case "error":
      return <>{result.message}</>;
  }
}
