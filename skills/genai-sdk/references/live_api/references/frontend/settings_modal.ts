/**
 * @fileoverview Owns the settings modal UI: open/close lifecycle and the
 * read-only sidebar config summary, plus the builder for the
 * BidiGenerateContentSetup JSON sent to /start. The only supported backend
 * is the public Vertex AI LiveAPI WebSocket.
 */

import * as constants from './constants';

/** All DOM elements consumed by `SettingsModal`. */
export interface SettingsModalElements {
  modal: HTMLElement;
  openButton: HTMLButtonElement;
  doneButton: HTMLButtonElement;
  wsEnvironmentSelect: HTMLSelectElement;
  wsLocationSelect: HTMLSelectElement;
  wsEndpointDisplay: HTMLInputElement;
  modelInput: HTMLSelectElement;
  modelValueDisplay: HTMLInputElement;
  voiceInput: HTMLInputElement;
  langInput: HTMLInputElement;
  systemInstructionTextarea: HTMLTextAreaElement;
  modalityAudio: HTMLInputElement;
  modalityText: HTMLInputElement;
  genTemperature: HTMLInputElement;
  genTopP: HTMLInputElement;
  genTopK: HTMLInputElement;
  genMaxTokens: HTMLInputElement;
  inputTransCheckbox: HTMLInputElement;
  inputTransLanguageMode: HTMLSelectElement;
  inputTransLanguageCodes: HTMLInputElement;
  outputTransCheckbox: HTMLInputElement;
  outputTransLanguageMode: HTMLSelectElement;
  outputTransLanguageCodes: HTMLInputElement;
  activityHandlingSelect: HTMLSelectElement;
  turnCoverageSelect: HTMLSelectElement;
  disableAadCheckbox: HTMLInputElement;
  aadStartSensitivitySelect: HTMLSelectElement;
  aadEndSensitivitySelect: HTMLSelectElement;
  aadPrefixPaddingMsInput: HTMLInputElement;
  aadSilenceDurationMsInput: HTMLInputElement;
  ctxCompressionCheckbox: HTMLInputElement;
  ctxTriggerInput: HTMLInputElement;
  ctxTargetInput: HTMLInputElement;
  proactiveAudioCheckbox: HTMLInputElement;
  setupOverrideTextarea: HTMLTextAreaElement;
  summary: {
    endpoint: HTMLElement;
    model: HTMLElement;
    voice: HTMLElement;
    language: HTMLElement;
  };
}

// JSON-shaped object built dynamically from the settings form. Typed as
// `any` so the field-by-field assembly below can use dot notation.
// tslint:disable-next-line:no-any
type JsonObject = any;

/** Backs the Settings modal: form state + setup JSON builder. */
export class SettingsModal {
  /**
   * Cloud project id resolved by the server (GET /project_info), used by
   * the websocket backend to build the fully-qualified model resource
   * name. Empty until `setProjectId()` is called.
   */
  private projectId = '';

  /**
   * @param onModelsShouldRefresh Called when the page should re-fetch /
   *     re-populate the model dropdown (e.g. on initial load).
   */
  constructor(
    private readonly els: SettingsModalElements,
    private readonly showStatus: (msg: string, isError?: boolean) => void,
    private readonly onModelsShouldRefresh: () => void,
  ) {
    this.populateWebsocketLocations();
    this.bindEvents();
    this.refreshConfigSummary();
    this.onModelsShouldRefresh();
  }

  /**
   * Populates the WebSocket location <select> with the configured list and
   * pre-selects the default location/environment from constants.
   */
  private populateWebsocketLocations() {
    const els = this.els;
    if (!els.wsLocationSelect) return;
    els.wsLocationSelect.replaceChildren();
    for (const loc of constants.WEBSOCKET_LOCATIONS) {
      const opt = document.createElement('option');
      opt.value = loc;
      opt.textContent = loc;
      els.wsLocationSelect.appendChild(opt);
    }
    els.wsLocationSelect.value = constants.WEBSOCKET_DEFAULT_LOCATION;
    if (els.wsEnvironmentSelect) {
      els.wsEnvironmentSelect.value = constants.WEBSOCKET_DEFAULT_ENV;
    }
    this.recomputeWebsocketEndpoint();
  }

  /**
   * Recomputes the websocket endpoint URL from the current Environment +
   * Location selection and writes it to the read-only display field.
   */
  private recomputeWebsocketEndpoint() {
    const els = this.els;
    if (
      !els.wsEnvironmentSelect ||
      !els.wsLocationSelect ||
      !els.wsEndpointDisplay
    ) {
      return;
    }
    els.wsEndpointDisplay.value = constants.computeWebsocketEndpoint(
      els.wsEnvironmentSelect.value,
      els.wsLocationSelect.value,
    );
  }

  /**
   * Caches the active Cloud project id. Required by the websocket backend
   * to build the fully-qualified model resource name on /start.
   */
  setProjectId(projectId: string) {
    this.projectId = projectId || '';
  }

  private bindEvents() {
    const els = this.els;
    els.openButton.addEventListener('click', () => {
      this.open();
    });
    els.doneButton.addEventListener('click', () => {
      const override = els.setupOverrideTextarea.value.trim();
      if (override) {
        try {
          JSON.parse(override);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          this.showStatus(`Invalid setup JSON override: ${message}`, true);
          return;
        }
      }
      this.refreshConfigSummary();
      this.close();
    });
    // Any [data-close-modal] (X, Cancel, backdrop) closes the modal.
    for (const el of els.modal.querySelectorAll('[data-close-modal]')) {
      el.addEventListener('click', () => {
        this.close();
      });
    }
    document.addEventListener('keydown', (event) => {
      const ke = event as KeyboardEvent;
      if (ke.key === 'Escape' && !els.modal.hidden) this.close();
    });

    for (const el of [els.voiceInput, els.langInput]) {
      el.addEventListener('input', () => {
        this.refreshConfigSummary();
      });
    }
    if (els.wsEnvironmentSelect) {
      els.wsEnvironmentSelect.addEventListener('change', () => {
        this.recomputeWebsocketEndpoint();
        this.refreshConfigSummary();
      });
    }
    if (els.wsLocationSelect) {
      els.wsLocationSelect.addEventListener('change', () => {
        this.recomputeWebsocketEndpoint();
        this.refreshConfigSummary();
      });
    }
    els.modelInput.addEventListener('change', () => {
      this.refreshConfigSummary();
    });
  }

  /** Opens the modal. */
  open() {
    this.els.modal.hidden = false;
  }
  /** Closes the modal. */
  close() {
    this.els.modal.hidden = true;
  }

  /**
   * Returns the WebSocket endpoint URL the caller should connect to,
   * computed from environment + location.
   */
  getEndpointUrl(): string {
    const els = this.els;
    return els.wsEndpointDisplay ? els.wsEndpointDisplay.value : '';
  }

  /** Mirrors the chosen settings into the read-only sidebar summary. */
  refreshConfigSummary() {
    const els = this.els;
    const wireModel = this.buildModelResourceName();
    els.summary.endpoint.textContent = this.getEndpointUrl() || '—';
    els.summary.model.textContent = wireModel || '—';
    els.summary.voice.textContent = els.voiceInput.value || '—';
    els.summary.language.textContent = els.langInput.value || '—';
    // The read-only model display under the dropdown shows the exact
    // qualified resource name sent on the wire.
    els.modelValueDisplay.value = wireModel || '';
  }

  /**
   * Returns the value to send as `BidiGenerateContentSetup.model`.
   *
   * The public Vertex API requires a fully-qualified resource name of the
   * form
   *   `projects/{project_id}/locations/{location}/publishers/google/models/{model_id}`
   * where `model_id` is what the user picked from the model dropdown
   * (e.g. `gemini-live-2.5-flash-native-audio`). The `project_id` comes
   * from `/project_info` and `location` from the websocket location
   * selector. If the YAML already provides a value with `publishers/...`
   * baked in, it is forwarded as-is so the prefix isn't double-applied.
   */
  private buildModelResourceName(): string {
    const els = this.els;
    const modelId = els.modelInput.value;
    if (!modelId) return '';
    // Allow YAML entries to provide a fully-qualified resource name
    // (or any `projects/.../publishers/...` form) verbatim.
    if (modelId.startsWith('projects/') || modelId.startsWith('publishers/')) {
      return modelId;
    }
    const location = (els.wsLocationSelect && els.wsLocationSelect.value) || '';
    if (!this.projectId || !location) {
      // Fall back to the bare id if we don't yet know the project / loc;
      // the server will surface the resulting validation error.
      return modelId;
    }
    return (
      `projects/${this.projectId}/locations/${location}` +
      `/publishers/google/models/${modelId}`
    );
  }

  /**
   * Builds the inner `BidiGenerateContentSetup` JSON from the form fields.
   */
  private buildInnerSetup(): JsonObject {
    const els = this.els;
    const responseModalities: string[] = [];
    if (els.modalityAudio.checked) responseModalities.push('AUDIO');
    if (els.modalityText.checked) responseModalities.push('TEXT');

    const generationConfig: JsonObject = {
      responseModalities,
      speechConfig: {
        voiceConfig: {prebuiltVoiceConfig: {voiceName: els.voiceInput.value}},
        languageCode: els.langInput.value,
      },
    };
    if (els.genTemperature.value !== '') {
      generationConfig.temperature = Number(els.genTemperature.value);
    }
    if (els.genTopP.value !== '') {
      generationConfig.topP = Number(els.genTopP.value);
    }
    if (els.genTopK.value !== '') {
      generationConfig.topK = Number(els.genTopK.value);
    }
    if (els.genMaxTokens.value !== '') {
      generationConfig.maxOutputTokens = Number(els.genMaxTokens.value);
    }

    const setup: JsonObject = {
      model: this.buildModelResourceName(),
      generationConfig,
      systemInstruction: {parts: [{text: els.systemInstructionTextarea.value}]},
    };

    // AudioTranscriptionConfig.language_config oneof selects either
    // `language_auto` (empty
    // message) or `language_hints.language_codes[]`.
    const buildTranscriptionConfig = (
      modeSel: HTMLSelectElement | undefined,
      codesInput: HTMLInputElement | undefined,
    ): JsonObject => {
      const cfg: JsonObject = {};
      const mode = modeSel ? modeSel.value : '';
      if (mode === 'auto') {
        cfg.languageAuto = {};
      } else if (mode === 'hints') {
        const codes =
          codesInput && codesInput.value
            ? codesInput.value.split(/[\s,]+/).filter(Boolean)
            : [];
        cfg.languageHints = {languageCodes: codes};
      }
      return cfg;
    };
    if (els.inputTransCheckbox.checked) {
      setup.inputAudioTranscription = buildTranscriptionConfig(
        els.inputTransLanguageMode,
        els.inputTransLanguageCodes,
      );
    }
    if (els.outputTransCheckbox.checked) {
      setup.outputAudioTranscription = buildTranscriptionConfig(
        els.outputTransLanguageMode,
        els.outputTransLanguageCodes,
      );
    }

    // realtime_input_config: only emit fields the user actually set so
    // server-side defaults remain in effect.
    const realtimeInputConfig: JsonObject = {};
    if (els.activityHandlingSelect.value) {
      realtimeInputConfig.activityHandling = els.activityHandlingSelect.value;
    }
    if (els.turnCoverageSelect && els.turnCoverageSelect.value) {
      realtimeInputConfig.turnCoverage = els.turnCoverageSelect.value;
    }
    const aad: JsonObject = {};
    if (els.disableAadCheckbox.checked) aad.disabled = true;
    if (els.aadStartSensitivitySelect && els.aadStartSensitivitySelect.value) {
      aad.startOfSpeechSensitivity = els.aadStartSensitivitySelect.value;
    }
    if (els.aadEndSensitivitySelect && els.aadEndSensitivitySelect.value) {
      aad.endOfSpeechSensitivity = els.aadEndSensitivitySelect.value;
    }
    if (
      els.aadPrefixPaddingMsInput &&
      els.aadPrefixPaddingMsInput.value !== ''
    ) {
      aad.prefixPaddingMs = Number(els.aadPrefixPaddingMsInput.value);
    }
    if (
      els.aadSilenceDurationMsInput &&
      els.aadSilenceDurationMsInput.value !== ''
    ) {
      aad.silenceDurationMs = Number(els.aadSilenceDurationMsInput.value);
    }
    if (Object.keys(aad).length > 0) {
      realtimeInputConfig.automaticActivityDetection = aad;
    }
    if (Object.keys(realtimeInputConfig).length > 0) {
      setup.realtimeInputConfig = realtimeInputConfig;
    }

    if (els.ctxCompressionCheckbox.checked) {
      setup.contextWindowCompression = {
        triggerTokens: Number(els.ctxTriggerInput.value) || 100000,
        slidingWindow: {targetTokens: Number(els.ctxTargetInput.value) || 4000},
      };
    }
    if (els.proactiveAudioCheckbox.checked) {
      setup.proactivity = {proactiveAudio: true};
    }
    return setup;
  }

  /**
   * Builds the wire-level `BidiGenerateContentClientMessage` JSON sent to
   * /start, shaped as `{"setup": {...}}`.
   *
   * If the user pasted JSON into the override textarea, that JSON is used
   * verbatim and is expected to already be in the correct wire shape.
   */
  buildSetupJson(): JsonObject {
    const els = this.els;
    const overrideText = els.setupOverrideTextarea.value.trim();
    if (overrideText) {
      return JSON.parse(overrideText) as JsonObject;
    }
    return {setup: this.buildInnerSetup()};
  }
}
