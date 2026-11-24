/**
 * OnboardingWizard — §3.2 bootstrap sequence as a Web wizard (M3-3.7): the
 * host shows this when the team is empty (no bots). Three steps, zero
 * terminal: pick provider → paste key (save + one-shot test) → pick the
 * Chief's model and create the team (chief + default room + first start).
 * Uses only existing endpoints — no wizard-specific API (§3.2 contract).
 */
import { useEffect, useState } from "react";
import {
  getSettingsProviders,
  jsonFetch,
  post,
  putProvider,
  testProvider,
  THINKING_LEVELS,
  type ProviderSettingsEntry,
} from "./api";
import { ModelPicker } from "./ModelPicker";

type T = ReturnType<typeof import("./i18n").makeT>;

interface Props {
  t: T;
  onDone: () => Promise<void>;
}

const TOTAL = 3;

export function OnboardingWizard(p: Props): JSX.Element {
  const { t } = p;
  const [step, setStep] = useState(1);
  const [entries, setEntries] = useState<ProviderSettingsEntry[] | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [customMode, setCustomMode] = useState(false);
  const [customId, setCustomId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [keyErr, setKeyErr] = useState<string | null>(null);
  const [testLine, setTestLine] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [modelId, setModelId] = useState("");
  const [thinking, setThinking] = useState("low");
  const [chiefName, setChiefName] = useState("Chief");
  const [finishErr, setFinishErr] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  // A non-409 room failure leaves the team created but the note would die
  // with the component on auto-close — hold the wizard open behind a Done
  // button instead (R1 P3-10).
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    void getSettingsProviders()
      .then((r) => setEntries(r.providers))
      .catch(() => setEntries(null));
  }, []);

  const chosen = customMode ? customId.trim() : provider;
  const chosenEntry = entries?.find((e) => e.id === chosen) ?? null;

  const pickProvider = (id: string): void => {
    setProvider(id);
    setCustomMode(false);
    setSaved(false);
    setTestLine(null);
    setTestOk(null);
    setStep(2);
  };

  const saveKey = async (): Promise<void> => {
    if (chosen === null || chosen === "") return;
    setSaving(true);
    setKeyErr(null);
    try {
      const patch: { apiKey?: string; baseUrl?: string } = {};
      if (apiKey.trim() !== "") patch.apiKey = apiKey.trim();
      if (baseUrl.trim() !== "") patch.baseUrl = baseUrl.trim();
      if (Object.keys(patch).length > 0) {
        await putProvider(chosen, patch);
      }
      setSaved(true);
      // One-shot test (nothing probed host-side): the user sees the honest
      // outcome before building the team on top; failure does not block.
      try {
        const r = await testProvider(chosen);
        setTestOk(r.ok);
        setTestLine(r.ok
          ? (r.models.length > 0 ? t.providerTestOk(r.models.length) : t.providerTestOkEmpty)
          : testFailText(t, r.error.code, r.error.message));
      } catch (e) {
        setTestOk(false);
        setTestLine(String(e).slice(0, 160));
      }
      const r = await getSettingsProviders();
      setEntries(r.providers);
    } catch (e) {
      setKeyErr(String(e).slice(0, 200));
    } finally {
      setSaving(false);
    }
  };

  const finish = async (): Promise<void> => {
    setFinishing(true);
    setFinishErr(null);
    try {
      // §3.2: chief (workDir defaults server-side for chief:true) → default
      // room (admin=chief) → first start. Existing rooms/names reuse.
      const bot = await jsonFetch<{ id: string }>("/api/bots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: chiefName.trim() !== "" ? chiefName.trim() : "Chief",
          chief: true,
          model: { provider: chosen, modelId, thinkingLevel: thinking },
        }),
      });
      let roomFailed = false;
      try {
        await post("/api/rooms", { name: "default", members: [bot.id], admin: bot.id });
      } catch (e) {
        // 409 = a "default" room already exists (retry after a half-done
        // run) — fine. Anything else: the team exists, so keep going, but
        // hold the wizard open with the note instead of auto-closing.
        if ((e as { status?: number }).status !== 409) {
          setFinishErr(`${String(e).slice(0, 120)} — ${t.onboardingRoomNote}`);
          roomFailed = true;
        }
      }
      try {
        await post(`/api/bots/${bot.id}/start`);
      } catch {
        // A failed start surfaces through the normal failure surfaces; the
        // team exists and the key can be fixed in Settings.
      }
      setFinishing(false);
      if (roomFailed) setBlocked(true);
      else await p.onDone();
    } catch (e) {
      setFinishErr(String(e).slice(0, 200));
      setFinishing(false);
    }
  };

  const pickerInfo = entries?.map((e) => ({
    id: e.id, label: e.label, configured: e.configured, preset: e.preset,
    ...(e.api !== undefined ? { api: e.api } : {}),
    ...(e.baseUrl !== undefined ? { baseUrl: e.baseUrl } : {}),
    models: e.models,
  })) ?? null;

  return (
    <div className="overlay">
      <div className="overlay-panel wizard">
        <h2>{t.onboardingWelcome}</h2>
        <div className="dim">{t.onboardingSub}</div>
        <div className="wizard-steps">
          {[1, 2, 3].map((n) => (
            <span key={n} className={`wizard-step ${step === n ? "active" : ""}`}>
              {n === 1 ? t.onboardingPickProvider : n === 2 ? t.providerKeyLabel : t.onboardingPickModel} · {t.onboardingStep(n, TOTAL)}
            </span>
          ))}
        </div>

        {step === 1 && (
          <>
            <div className="prov-name">{t.onboardingPickProvider}</div>
            <div className="preset-grid">
              {(entries ?? []).filter((e) => e.preset || e.entryPresent).map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={`preset-card ${provider === e.id && !customMode ? "sel" : ""}`}
                  onClick={() => pickProvider(e.id)}
                >
                  <span className="pc-name">{e.configured ? "✓ " : ""}{e.label}</span>
                  <span className="pc-sub">{e.models.slice(0, 2).map((m) => m.id).join(" · ")}</span>
                </button>
              ))}
              <button
                type="button"
                className={`preset-card ${customMode ? "sel" : ""}`}
                onClick={() => { setCustomMode(true); setProvider(null); }}
              >
                <span className="pc-name">{t.providersCustom}</span>
                <span className="pc-sub">{t.providerAddTitle}</span>
              </button>
            </div>
            {customMode && (
              <div className="form">
                <input placeholder={t.providerLabel} value={customId} onChange={(e) => setCustomId(e.target.value)} />
                <div className="form-row">
                  <button className="primary" disabled={customId.trim() === ""} onClick={() => setStep(2)}>{t.onboardingNext}</button>
                </div>
              </div>
            )}
          </>
        )}

        {step === 2 && chosen !== null && chosen !== "" && (
          <>
            <div className="prov-name">{t.onboardingPasteKey(chosenEntry?.label ?? chosen)}</div>
            <div className="form">
              <input
                type="password"
                placeholder={t.providerKeyPlaceholder}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <div className="dim">{t.onboardingKeyHelp}</div>
              <input
                placeholder={chosenEntry?.baseUrl !== undefined
                  ? t.providerBaseUrlHint(chosenEntry.baseUrl)
                  : t.providerBaseUrlLabel}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              {keyErr !== null && <div className="error">{keyErr}</div>}
              <div className="form-row">
                <button
                  className="primary"
                  // Keyless relays are legitimate: a baseUrl alone (or an
                  // already-present key with a new endpoint) configures fine.
                  disabled={saving || (!chosenEntry?.keyPresent && apiKey.trim() === "" && baseUrl.trim() === "")}
                  onClick={() => void saveKey()}
                >
                  {t.onboardingSaveTest}
                </button>
                {saving && <span className="dim">{t.providerTestRunning}</span>}
              </div>
              {testLine !== null && <div className={`test-line ${testOk === true ? "ok" : "bad"}`}>{testLine}</div>}
              {saved && (
                <div className="form-row">
                  <button className="primary" onClick={() => setStep(3)}>{t.onboardingNext}</button>
                </div>
              )}
              <div className="form-row">
                <button className="ghost" onClick={() => setStep(1)}>{t.onboardingBack}</button>
              </div>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className="prov-name">{t.onboardingPickModel}</div>
            <div className="form">
              <ModelPicker
                t={t}
                providers={pickerInfo}
                provider={chosen ?? ""}
                modelId={modelId}
                // The provider may still change here (e.g. a second
                // configured one); the ⚠ jumps BACK to the key step instead
                // of into a separate settings page — the wizard IS the
                // settings surface during bootstrap.
                onOpenSettings={() => setStep(2)}
                onProvider={(v) => { setCustomMode(false); setProvider(v); }}
                onModelId={setModelId}
              />
              <div className="form-row">
                <input placeholder={t.nameLabel} value={chiefName} onChange={(e) => setChiefName(e.target.value)} />
                <select aria-label={t.thinkingLabel} value={thinking} onChange={(e) => setThinking(e.target.value)}>
                  {THINKING_LEVELS.map((lv) => <option key={lv} value={lv}>{lv}</option>)}
                </select>
              </div>
              <div className="dim">{t.onboardingChiefHint}</div>
              {finishErr !== null && <div className="error">{finishErr}</div>}
              <div className="form-row">
                {blocked ? (
                  <button className="primary" onClick={() => void p.onDone()}>{t.onboardingDoneAnyway}</button>
                ) : (
                  <button
                    className="primary"
                    disabled={finishing || modelId === "" || chosen === null || chosen === ""}
                    onClick={() => void finish()}
                  >
                    {t.onboardingFinish}
                  </button>
                )}
                {!blocked && <button className="ghost" onClick={() => setStep(2)}>{t.onboardingBack}</button>}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function testFailText(t: T, code: "auth" | "not_found" | "timeout" | "network", message: string): string {
  if (code === "auth") return t.providerErrAuth;
  if (code === "not_found") return t.providerErrNotFound;
  if (code === "timeout") return t.providerErrTimeout;
  return `${t.providerErrNetwork}: ${message}`;
}
