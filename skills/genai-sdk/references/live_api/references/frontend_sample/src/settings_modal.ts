/**
 * Owns the settings modal UI: open/close lifecycle, the WebSocket
 * environment/location pickers, the read-only sidebar config summary, and
 * builds the `BidiGenerateContentSetup` proto-JSON sent on /start.
 *
 * Public Vertex Live API only. The internal app's `beyond` / `groot`
 * backends, MCP, and Groot wrapper-fields are intentionally absent.
 */

import * as constants from './constants.js';

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
  outputTransCheckbox: HTMLInputElement;
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
  setupOverrideTextarea: HTMLTextAreaElement;
  summary: {
    endpoint: HTMLElement;
    model: HTMLElement;
    voice: HTMLElement;
    language: HTMLElement;
  };
}

// JSON-shaped object built dynamically from the settings form. Typed loose
// because the structure is dictated by the proto-JSON schema, not by TS.
type JsonObject = Record<string, unknown>;

/** Backs the Settings modal: form state + setup JSON builder. */
export class SettingsModal {
  /**
   * Cloud project id resolved by the server (GET /project_info), used to
   * build the fully-qualified model resource name. Empty until
   * `setProjectId()` is called.
   */
  private projectId = '';

  constructor(
    private readonly els: SettingsModalElements,
    private readonly showStatus: (msg: string, isError?: boolean) => void,
  ) {
    this.populateWebsocketLocations();
    this.bindEvents();
    this.refreshConfigSummary();
  }

  private populateWebsocketLocations() {
    const els = this.els;
    els.wsLocationSelect.replaceChildren();
    for (const loc of constants.WEBSOCKET_LOCATIONS) {
      const opt = document.createElement('option');
      opt.value = loc;
      opt.textContent = loc;
      els.wsLocationSelect.appendChild(opt);
    }
    els.wsLocationSelect.value = constants.WEBSOCKET_DEFAULT_LOCATION;
    els.wsEnvironmentSelect.value = constants.WEBSOCKET_DEFAULT_ENV;
    this.recomputeWebsocketEndpoint();
  }

  private recomputeWebsocketEndpoint() {
    const els = this.els;
    els.wsEndpointDisplay.value = constants.computeWebsocketEndpoint(
      els.wsEnvironmentSelect.value,
      els.wsLocationSelect.value,
    );
  }

  /** Caches the active Cloud project id. */
  setProjectId(projectId: string) {
    this.projectId = projectId || '';
    this.refreshConfigSummary();
  }

  private bindEvents() {
    const els = this.els;
    els.openButton.addEventListener('click', () => this.open());
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
    for (const el of els.modal.querySelectorAll('[data-close-modal]')) {
      el.addEventListener('click', () => this.close());
    }
    document.addEventListener('keydown', (event) => {
      const ke = event as KeyboardEvent;
      if (ke.key === 'Escape' && !els.modal.hidden) this.close();
    });

    for (const el of [els.voiceInput, els.langInput]) {
      el.addEventListener('input', () => this.refreshConfigSummary());
    }
    els.wsEnvironmentSelect.addEventListener('change', () => {
      this.recomputeWebsocketEndpoint();
      this.refreshConfigSummary();
    });
    els.wsLocationSelect.addEventListener('change', () => {
      this.recomputeWebsocketEndpoint();
      this.refreshConfigSummary();
    });
    els.modelInput.addEventListener('change', () => this.refreshConfigSummary());
  }

  open() {
    this.els.modal.hidden = false;
  }
  close() {
    this.els.modal.hidden = true;
  }

  /** The fully-qualified WebSocket URL the server should connect to. */
  getEndpointUrl(): string {
    return this.els.wsEndpointDisplay.value;
  }

  /** The chosen GCP location (e.g. `us-central1` or `global`). */
  getLocation(): string {
    return this.els.wsLocationSelect.value;
  }

  /** Mirrors the chosen settings into the read-only sidebar summary. */
  refreshConfigSummary() {
    const els = this.els;
    const wireModel = this.buildModelResourceName();
    els.summary.endpoint.textContent = this.getEndpointUrl() || '—';
    els.summary.model.textContent = wireModel || '—';
    els.summary.voice.textContent = els.voiceInput.value || '—';
    els.summary.language.textContent = els.langInput.value || '—';
    els.modelValueDisplay.value = wireModel || '';
  }

  /**
   * Returns the value to send as `BidiGenerateContentSetup.model`.
   *
   * The public Vertex Live API requires a fully qualified resource name:
   *   `projects/{project_id}/locations/{location}/publishers/google/models/{model_id}`
   * If the YAML already provides a value starting with `projects/` or
   * `publishers/`, forward it as-is.
   */
  private buildModelResourceName(): string {
    const els = this.els;
    const modelId = els.modelInput.value;
    if (!modelId) return '';
    if (modelId.startsWith('projects/') || modelId.startsWith('publishers/')) {
      return modelId;
    }
    const location = els.wsLocationSelect.value;
    if (!this.projectId || !location) {
      // Fall back to the bare id; the server will surface the error.
      return modelId;
    }
    return (
      `projects/${this.projectId}/locations/${location}` +
      `/publishers/google/models/${modelId}`
    );
  }

  /**
   * Builds the inner `BidiGenerateContentSetup` JSON from the form fields.
   * Uses proto3 JSON conventions: camelCase keys; enums as string names.
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
      generationConfig['temperature'] = Number(els.genTemperature.value);
    }
    if (els.genTopP.value !== '') {
      generationConfig['topP'] = Number(els.genTopP.value);
    }
    if (els.genTopK.value !== '') {
      generationConfig['topK'] = Number(els.genTopK.value);
    }
    if (els.genMaxTokens.value !== '') {
      generationConfig['maxOutputTokens'] = Number(els.genMaxTokens.value);
    }

    const setup: JsonObject = {
      model: this.buildModelResourceName(),
      generationConfig,
      systemInstruction: {parts: [{text: els.systemInstructionTextarea.value}]},
    };

    if (els.inputTransCheckbox.checked) {
      // AudioTranscriptionConfig: leave language_codes empty on Vertex.
      setup['inputAudioTranscription'] = {};
    }
    if (els.outputTransCheckbox.checked) {
      setup['outputAudioTranscription'] = {};
    }

    // realtime_input_config: only emit fields the user explicitly set so
    // server-side defaults remain in effect for everything else.
    const realtimeInputConfig: JsonObject = {};
    if (els.activityHandlingSelect.value) {
      realtimeInputConfig['activityHandling'] = els.activityHandlingSelect.value;
    }
    if (els.turnCoverageSelect.value) {
      realtimeInputConfig['turnCoverage'] = els.turnCoverageSelect.value;
    }
    const aad: JsonObject = {};
    if (els.disableAadCheckbox.checked) aad['disabled'] = true;
    if (els.aadStartSensitivitySelect.value) {
      aad['startOfSpeechSensitivity'] = els.aadStartSensitivitySelect.value;
    }
    if (els.aadEndSensitivitySelect.value) {
      aad['endOfSpeechSensitivity'] = els.aadEndSensitivitySelect.value;
    }
    if (els.aadPrefixPaddingMsInput.value !== '') {
      aad['prefixPaddingMs'] = Number(els.aadPrefixPaddingMsInput.value);
    }
    if (els.aadSilenceDurationMsInput.value !== '') {
      aad['silenceDurationMs'] = Number(els.aadSilenceDurationMsInput.value);
    }
    if (Object.keys(aad).length > 0) {
      realtimeInputConfig['automaticActivityDetection'] = aad;
    }
    if (Object.keys(realtimeInputConfig).length > 0) {
      setup['realtimeInputConfig'] = realtimeInputConfig;
    }

    if (els.ctxCompressionCheckbox.checked) {
      // proto3 int64 is JSON-encoded as a string on the wire; the server
      // re-parses it through proto json_format which accepts both.
      setup['contextWindowCompression'] = {
        triggerTokens: String(Number(els.ctxTriggerInput.value) || 100000),
        slidingWindow: {
          targetTokens: String(Number(els.ctxTargetInput.value) || 4000),
        },
      };
    }

    return setup;
  }

  /**
   * Builds the wire-level client-message JSON sent to /start. The server
   * forwards this verbatim to the Live API endpoint as the first frame.
   *
   *     BidiGenerateContentClientMessage = {"setup": {...}}
   *
   * If the user pasted JSON into the override textarea, that JSON is used
   * verbatim and is expected to already be in the correct wire shape
   * (i.e. `{"setup": {...}}`).
   */
  buildSetupJson(): JsonObject {
    const overrideText = this.els.setupOverrideTextarea.value.trim();
    if (overrideText) {
      return JSON.parse(overrideText) as JsonObject;
    }
    return {setup: this.buildInnerSetup()};
  }
}
