/**
 * ModelPicker — the v3 discovery dropdowns (provider + model), shared by the
 * create-bot form (Roster) and the bot-detail editor (ContextPanel).
 *
 * providers === null ⇒ fetch failed (or not yet loaded): degrade to the old
 * free-text inputs — the form stays usable, just without discovery.
 * A current value that is not among the options (bots-only relay providers,
 * custom model ids) auto-selects "Custom…" and keeps the value — the picker
 * must always be able to represent what a bot already runs. Clearing the
 * custom input falls back to the dropdown (no one-way dead end).
 */
import { useState } from "react";
import type { ProviderInfo } from "./api";

type T = ReturnType<typeof import("./i18n").makeT>;

const CUSTOM = "__custom__";

function badgeText(t: T, badge?: string): string {
  if (badge === "flagship") return t.badgeFlagship;
  if (badge === "balanced") return t.badgeBalanced;
  if (badge === "fast") return t.badgeFast;
  if (badge === "budget") return t.badgeBudget;
  return "";
}

interface Props {
  t: T;
  providers: ProviderInfo[] | null;
  provider: string;
  modelId: string;
  onProvider: (provider: string) => void;
  onModelId: (modelId: string) => void;
  /** M3-3.7: when given, the keyless-provider ⚠ becomes a jump into the
   *  Settings overlay (carrying the provider id — the settings page opens
   *  that card's prefilled edit form), closing the dead end. */
  onOpenSettings?: (providerId: string) => void;
}

export function ModelPicker(props: Props): JSX.Element {
  const { t, providers } = props;
  // Custom mode is tracked per field independently of the providers list;
  // clearing the custom input drops back to the dropdown.
  const [providerCustom, setProviderCustom] = useState(false);
  const [modelCustom, setModelCustom] = useState(false);

  // --- free-text fallback (fetch failed / still loading) ---
  if (providers === null) {
    return (
      <>
        <input placeholder={t.providerLabel} value={props.provider} onChange={(e) => props.onProvider(e.target.value)} />
        <input placeholder={t.modelIdLabel} value={props.modelId} onChange={(e) => props.onModelId(e.target.value)} />
      </>
    );
  }

  const entry = providers.find((p) => p.id === props.provider);
  const providerKnown = entry !== undefined;
  const models = entry?.models ?? [];
  const modelKnown = models.some((m) => m.id === props.modelId);

  const setProvider = (value: string): void => {
    if (value === CUSTOM) {
      setProviderCustom(true);
      return; // keep the current text as the starting point
    }
    setProviderCustom(false);
    props.onProvider(value);
    // Provider switch: the old model id almost never exists on the new
    // provider — reset to its first listed model (the custom input stays
    // reachable via "Custom…" if the user really wants to carry an id over).
    const nextModels = providers.find((p) => p.id === value)?.models ?? [];
    if (!nextModels.some((m) => m.id === props.modelId)) {
      setModelCustom(false);
      props.onModelId(nextModels[0]?.id ?? "");
    }
  };
  const setModel = (value: string): void => {
    if (value === CUSTOM) {
      setModelCustom(true);
      return;
    }
    setModelCustom(false);
    props.onModelId(value);
  };
  // Clearing a custom input returns to the dropdown (dead-end fix).
  const customProviderChanged = (value: string): void => {
    props.onProvider(value);
    if (value === "") setProviderCustom(false);
  };
  const customModelChanged = (value: string): void => {
    props.onModelId(value);
    if (value === "") setModelCustom(false);
  };

  // Three groups: configured entries first, then built-in presets, then
  // other known providers (keys-only entries without a key, bots-only relay
  // providers) — those are NOT presets and must not be labeled as such.
  const configuredGroup = providers.filter((p) => p.configured);
  const presetGroup = providers.filter((p) => !p.configured && p.preset);
  const otherGroup = providers.filter((p) => !p.configured && !p.preset);
  const option = (p: ProviderInfo): JSX.Element => (
    <option key={p.id} value={p.id}>{p.label !== p.id ? `${p.label} (${p.id})` : p.id}</option>
  );

  return (
    <>
      {providerCustom || (props.provider !== "" && !providerKnown) ? (
        <input placeholder={t.providerLabel} value={props.provider} onChange={(e) => customProviderChanged(e.target.value)} />
      ) : (
        <select aria-label={t.providerLabel} value={providerKnown ? props.provider : ""} onChange={(e) => setProvider(e.target.value)}>
          <option value="" disabled>{t.providersPlaceholder}</option>
          {configuredGroup.length > 0 && (
            <optgroup label={t.providersConfigured}>{configuredGroup.map(option)}</optgroup>
          )}
          <optgroup label={t.providersPresets}>{presetGroup.map(option)}</optgroup>
          {otherGroup.length > 0 && (
            <optgroup label={t.providersOther}>{otherGroup.map(option)}</optgroup>
          )}
          <option value={CUSTOM}>{t.providersCustom}</option>
        </select>
      )}
      {entry !== undefined && !entry.configured && (
        props.onOpenSettings !== undefined ? (
          <button type="button" className="provider-warn-btn" title={t.providerNoKey} onClick={() => props.onOpenSettings?.(entry.id)}>
            ⚠ {t.providerFixInSettings}
          </button>
        ) : (
          <div className="provider-warn dim" title={t.providerNoKey}>⚠ {t.providerNoKey}</div>
        )
      )}
      {modelCustom || (props.modelId !== "" && !modelKnown) || models.length === 0 ? (
        <input placeholder={t.modelIdLabel} value={props.modelId} onChange={(e) => customModelChanged(e.target.value)} />
      ) : (
        <select aria-label={t.modelIdLabel} value={modelKnown ? props.modelId : ""} onChange={(e) => setModel(e.target.value)}>
          <option value="" disabled>{t.modelPlaceholder}</option>
          {models.map((m) => {
            const badge = badgeText(t, m.badge);
            return <option key={m.id} value={m.id}>{m.name !== undefined ? `${m.name} (${m.id})` : m.id}{badge !== "" ? ` · ${badge}` : ""}</option>;
          })}
          <option value={CUSTOM}>{t.modelCustom}</option>
        </select>
      )}
    </>
  );
}
