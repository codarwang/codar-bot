/**
 * SettingsOverlay — the M3-3.7 settings page (PRD ⑥): provider key entry /
 * test / delete + the review-model editor. The host does the heavy lifting:
 * GET echoes masked keys only, PUT/DELETE merge-write keys.json (atomic,
 * 0600, audited), POST test fires one {base}/models request. A test failure
 * never blocks a save — the card shows the honest outcome instead.
 */
import { useCallback, useEffect, useState } from "react";
import {
  deleteProvider,
  getSettingsProviders,
  jsonFetch,
  putProvider,
  testProvider,
  THINKING_LEVELS,
  type ProviderInfo,
  type ProviderSettingsEntry,
  type ProviderSettingsResponse,
  type ProviderTestResult,
} from "./api";
import { ModelPicker } from "./ModelPicker";

type T = ReturnType<typeof import("./i18n").makeT>;

interface Props {
  t: T;
  onClose: () => void;
}

interface TestView {
  id: string;
  running: boolean;
  ok?: boolean;
  text?: string;
}

/** Map an entry-surface report onto the discovery shape ModelPicker consumes
 *  (the two surfaces share labels/models by construction — §3.3). */
function toPickerInfo(entries: ProviderSettingsEntry[]): ProviderInfo[] {
  return entries.map((e) => ({
    id: e.id,
    label: e.label,
    configured: e.configured,
    preset: e.preset,
    ...(e.api !== undefined ? { api: e.api } : {}),
    ...(e.baseUrl !== undefined ? { baseUrl: e.baseUrl } : {}),
    models: e.models,
  }));
}

function testText(t: T, r: ProviderTestResult): string {
  if (r.ok) return r.models.length > 0 ? t.providerTestOk(r.models.length) : t.providerTestOkEmpty;
  return r.error.code === "auth" ? t.providerErrAuth
    : r.error.code === "not_found" ? t.providerErrNotFound
    : r.error.code === "timeout" ? t.providerErrTimeout
    : `${t.providerErrNetwork}: ${r.error.message}`;
}

export function SettingsOverlay(p: Props): JSX.Element {
  const { t } = p;
  const [entries, setEntries] = useState<ProviderSettingsEntry[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [tests, setTests] = useState<Record<string, TestView>>({});
  const [error, setError] = useState<string | null>(null);
  // review-model editor state (dead endpoint revived — PUT /api/settings/review-model)
  const [reviewModel, setReviewModel] = useState<{ provider: string; modelId: string; thinkingLevel: string } | null>(null);
  const [draftProvider, setDraftProvider] = useState("");
  const [draftModelId, setDraftModelId] = useState("");
  const [draftThinking, setDraftThinking] = useState("low");
  const [reviewMsg, setReviewMsg] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const r = await getSettingsProviders();
      setEntries(r.providers);
    } catch (e) {
      setError(String(e).slice(0, 160));
    }
  }, []);
  useEffect(() => {
    void reload();
    void jsonFetch<{ reviewModel: { provider: string; modelId: string; thinkingLevel: string } | null }>("/api/settings")
      .then((r) => {
        setReviewModel(r.reviewModel);
        setDraftProvider(r.reviewModel?.provider ?? "");
        setDraftModelId(r.reviewModel?.modelId ?? "");
        setDraftThinking(r.reviewModel?.thinkingLevel ?? "low");
      })
      .catch(() => undefined);
  }, [reload]);

  const runTest = async (id: string): Promise<void> => {
    setTests((prev) => ({ ...prev, [id]: { id, running: true } }));
    try {
      const r = await testProvider(id);
      setTests((prev) => ({ ...prev, [id]: { id, running: false, ok: r.ok, text: testText(t, r) } }));
    } catch (e) {
      setTests((prev) => ({ ...prev, [id]: { id, running: false, ok: false, text: String(e).slice(0, 160) } }));
    }
  };

  const remove = async (id: string): Promise<void> => {
    setError(null);
    try {
      const r = await deleteProvider(id);
      setEntries(r.providers);
    } catch (e) {
      setError(String(e).slice(0, 200));
    }
  };

  const saveReview = async (): Promise<void> => {
    setReviewMsg(null);
    try {
      const r = await jsonFetch<{ reviewModel: { provider: string; modelId: string; thinkingLevel: string } }>(
        "/api/settings/review-model",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: draftProvider, modelId: draftModelId, thinkingLevel: draftThinking }),
        },
      );
      setReviewModel(r.reviewModel);
      setReviewMsg("✓");
    } catch (e) {
      setReviewMsg(String(e).slice(0, 160));
    }
  };

  const pickerInfo = entries !== null ? toPickerInfo(entries) : null;
  const configurable = entries ?? [];

  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className="overlay-panel">
        <div className="overlay-head">
          <h2>{t.settings}</h2>
          <button className="ghost" onClick={p.onClose}>✕</button>
        </div>
        {error !== null && <div className="error">{error}</div>}

        <div className="roster-section">{t.settingsProviders}</div>
        {entries === null && <div className="dim">{t.loading}</div>}
        {entries !== null && configurable.length === 0 && <div className="dim">—</div>}
        {configurable.map((e) => (
          <ProviderCard
            key={e.id}
            t={t}
            entry={e}
            test={tests[e.id]}
            editing={editing === e.id}
            onStartEdit={() => setEditing(editing === e.id ? null : e.id)}
            onSaved={(r) => { setEntries(r.providers); void runTest(e.id); }}
            onTest={() => void runTest(e.id)}
            onDelete={() => void remove(e.id)}
          />
        ))}
        {entries !== null && (
          <AddCustom
            t={t}
            open={adding}
            onOpen={() => setAdding(!adding)}
            onSaved={(r) => { setEntries(r.providers); setAdding(false); }}
            onError={setError}
          />
        )}

        <div className="roster-section">{t.reviewModel}</div>
        <div className="form">
          <ModelPicker
            t={t}
            providers={pickerInfo}
            provider={draftProvider}
            modelId={draftModelId}
            onProvider={setDraftProvider}
            onModelId={setDraftModelId}
            onOpenSettings={(providerId) => setEditing(providerId)}
          />
          <div className="form-row">
            <select aria-label={t.thinkingLabel} value={draftThinking} onChange={(e) => setDraftThinking(e.target.value)}>
              {THINKING_LEVELS.map((lv) => <option key={lv} value={lv}>{lv}</option>)}
            </select>
            <button disabled={draftProvider === "" || draftModelId === ""} onClick={() => void saveReview()}>{t.save}</button>
            {reviewMsg !== null && <span className="dim">{reviewMsg}</span>}
          </div>
          <div className="dim">
            {t.settingsReviewHint}
            {reviewModel !== null && ` · ${reviewModel.provider}/${reviewModel.modelId}`}
            {reviewModel === null && ` · ${t.reviewModelNone}`}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProviderCard(p: {
  t: T;
  entry: ProviderSettingsEntry;
  test?: TestView;
  editing: boolean;
  onStartEdit: () => void;
  onSaved: (r: ProviderSettingsResponse) => void;
  onTest: () => void;
  onDelete: () => void;
}): JSX.Element {
  const { t, entry } = p;
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState(false);

  const startEdit = (): void => {
    setSavedNote(false);
    p.onStartEdit();
  };

  // Prefill on EVERY open — including opens driven from outside the card
  // (the review-model picker's ⚠ jumps here with the provider id). Keeping
  // this in an effect (not the click handler) means both paths get the same
  // honest starting values (R2-F2: a skipped prefill let a save silently
  // clear an api override the form never showed).
  useEffect(() => {
    if (p.editing) {
      setErr(null);
      setSavedNote(false);
      setApiKey("");
      setBaseUrl(entry.baseUrlCustom ? entry.baseUrl ?? "" : "");
      setApi(entry.api ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.editing]);

  // The exact PUT payload — computed for BOTH the disabled-check and the
  // save so a zero-change form can never 400 on "nothing to update" (R1 P3-6).
  const buildPatch = (): { apiKey?: string; baseUrl?: string | null; api?: string | null } => {
    const patch: { apiKey?: string; baseUrl?: string | null; api?: string | null } = {};
    if (apiKey.trim() !== "") patch.apiKey = apiKey.trim();
    // baseUrl: empty + currently custom → clear back to the preset default.
    if (baseUrl.trim() !== "") patch.baseUrl = baseUrl.trim();
    else if (entry.baseUrlCustom) patch.baseUrl = null;
    if (api !== "" && api !== entry.api) patch.api = api;
    else if (api === "" && entry.apiCustom) patch.api = null; // "—" clears the override back to the preset default
    return patch;
  };
  const patch = buildPatch();

  const save = async (): Promise<void> => {
    if (Object.keys(patch).length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await putProvider(entry.id, patch);
      setSavedNote(true);
      p.onSaved(r);
      p.onStartEdit(); // close the form (parent toggles editing off)
    } catch (e) {
      setErr(String(e).slice(0, 200));
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const r = await putProvider(entry.id, { apiKey: null });
      setApiKey("");
      p.onSaved(r);
      p.onStartEdit();
    } catch (e) {
      setErr(String(e).slice(0, 200));
    } finally {
      setBusy(false);
    }
  };

  const useChips = entry.inUse.map((u) => (
    <span key={`${u.kind}-${u.id ?? "review"}`} className="member-chip">{u.kind === "review" ? "★" : "🤖"} {u.name !== "" ? u.name : "review"} · {u.modelId}</span>
  ));

  return (
    <div className="prov-card">
      <div className="prov-head">
        <span className="prov-name">{entry.label}</span>
        {entry.id !== entry.label && <span className="dim">{entry.id}</span>}
        {entry.keyPresent ? (
          <span className="badge badge-idle">{entry.maskedKey}</span>
        ) : entry.entryPresent ? (
          <span className="badge badge-warn">{t.providerKeyUntouched}</span>
        ) : (
          <span className="badge badge-stopped">{t.providerFixInSettings}</span>
        )}
        {entry.inUse.length > 0
          ? <span className="badge badge-working">{t.providerInUse} ×{entry.inUse.length}</span>
          : <span className="badge badge-stopped">{t.providerUnused}</span>}
      </div>
      <div className="prov-meta">
        {entry.baseUrl !== undefined && <span>{entry.baseUrl}</span>}
        {entry.api !== undefined && <span> · {entry.api}</span>}
        {entry.baseUrl !== undefined && !entry.baseUrlCustom && entry.preset && <span> · {t.providerPresetEndpoint}</span>}
      </div>
      {useChips.length > 0 && <div className="prov-use">{useChips}</div>}
      <div className="prov-acts">
        <button className="mini" onClick={startEdit}>{entry.keyPresent ? t.providerKeyKeep : t.providerKeyLabel}{entry.keyPresent ? " ↻" : ""}</button>
        <button className="mini" disabled={p.test?.running === true} onClick={p.onTest}>
          {p.test?.running === true ? t.providerTestRunning : t.providerTest}
        </button>
        {entry.entryPresent && (
          <button className="mini danger" onClick={p.onDelete}>{t.delete}</button>
        )}
        {p.test !== undefined && !p.test.running && p.test.text !== undefined && (
          <span className={`test-line ${p.test.ok === true ? "ok" : "bad"}`}>{p.test.text}</span>
        )}
      </div>
      {p.editing && (
        <div className="prov-form">
          <input
            type="password"
            placeholder={t.providerKeyPlaceholder}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <div className="dim">
            {entry.keyPresent ? `${t.providerKeyKeep} · ${entry.maskedKey} · ${t.providerKeyUntouched}` : t.onboardingKeyHelp}
          </div>
          <input
            placeholder={entry.baseUrl !== undefined && !entry.baseUrlCustom
              ? t.providerBaseUrlHint(entry.baseUrl)
              : t.providerBaseUrlLabel}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <details>
            <summary className="dim">{t.providerAdvanced}</summary>
            <div className="form-row">
              <span className="dim">{t.providerApiLabel}</span>
              <select value={api} onChange={(e) => setApi(e.target.value)}>
                <option value="">—</option>
                <option value="openai-completions">openai-completions</option>
                <option value="openai-responses">openai-responses</option>
                <option value="anthropic-messages">anthropic-messages</option>
              </select>
            </div>
          </details>
          {err !== null && <div className="error">{err}</div>}
          <div className="form-row">
            <button className="primary" disabled={busy || Object.keys(patch).length === 0} onClick={() => void save()}>{t.save}</button>
            {entry.keyPresent && (
              <button className="ghost" disabled={busy} onClick={() => void clearKey()}>{t.providerClearKey}</button>
            )}
            {savedNote && <span className="dim">{t.providerSavedNote}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function AddCustom(p: {
  t: T;
  open: boolean;
  onOpen: () => void;
  onSaved: (r: ProviderSettingsResponse) => void;
  onError: (e: string | null) => void;
}): JSX.Element {
  const { t } = p;
  const [id, setId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    p.onError(null);
    try {
      const r = await putProvider(id.trim(), {
        ...(apiKey.trim() !== "" ? { apiKey: apiKey.trim() } : {}),
        ...(baseUrl.trim() !== "" ? { baseUrl: baseUrl.trim() } : {}),
        ...(api !== "" ? { api } : {}),
      });
      p.onSaved(r);
      setId("");
      setApiKey("");
      setBaseUrl("");
      setApi("");
    } catch (e) {
      setErr(String(e).slice(0, 200));
    } finally {
      setBusy(false);
    }
  };

  if (!p.open) {
    return (
      <div className="prov-acts">
        <button className="ghost" onClick={p.onOpen}>{t.providerAddBtn}</button>
      </div>
    );
  }
  // A protocol alone configures nothing — at least a key or an endpoint.
  const canSave = id.trim() !== "" && (apiKey.trim() !== "" || baseUrl.trim() !== "");
  return (
    <div className="prov-form">
      <div className="dim">{t.providerAddTitle}</div>
      <input placeholder={t.providerLabel} value={id} onChange={(e) => setId(e.target.value)} />
      <input type="password" placeholder={t.providerKeyPlaceholder} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      <input placeholder={t.providerBaseUrlLabel} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      <div className="form-row">
        <span className="dim">{t.providerApiLabel}</span>
        <select value={api} onChange={(e) => setApi(e.target.value)}>
          <option value="">—</option>
          <option value="openai-completions">openai-completions</option>
          <option value="openai-responses">openai-responses</option>
          <option value="anthropic-messages">anthropic-messages</option>
        </select>
      </div>
      {err !== null && <div className="error">{err}</div>}
      <div className="form-row">
        <button className="primary" disabled={busy || !canSave} onClick={() => void save()}>{t.save}</button>
        <button className="ghost" onClick={p.onOpen}>{t.cancel}</button>
      </div>
    </div>
  );
}
