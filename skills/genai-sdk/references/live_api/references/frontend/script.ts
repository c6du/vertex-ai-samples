/**
 * @fileoverview Entry point for the Live API testing playground. Looks up
 * DOM elements, instantiates the controllers from the sibling modules, and
 * wires together the session start/stop flow plus the chat-input handler.
 *
 * The heavy lifting lives in:
 *   - settings_modal.ts: form + setup JSON builder
 *   - config_loader.ts:  /models loader
 *   - audio.ts / video.ts: capture + playback controllers
 *   - websocket_client.ts: protocol bridge to the backend
 *   - conversation_view.ts: bubble rendering
 *   - status_view.ts: indicator + transient toasts
 */

import {bytesToBase64, MicCaptureController, PlaybackController} from './audio';
import {ModelsLoader} from './config_loader';
import * as constants from './constants';
import {ConversationView} from './conversation_view';
import * as projectInfo from './project_info';

import {initRecordingViewer} from './recording_viewer';
import {SettingsModal} from './settings_modal';
import {SessionStatusIndicator, StatusMessage} from './status_view';
import {VideoController} from './video';
import {WebSocketClient} from './websocket_client';

document.addEventListener('DOMContentLoaded', () => {
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const sel = (id: string) => byId(id) as HTMLSelectElement;
  const inp = (id: string) => byId(id) as HTMLInputElement;
  const btn = (id: string) => byId(id) as HTMLButtonElement;
  const txta = (id: string) => byId(id) as HTMLTextAreaElement;

  // ---- Top-level chrome ----
  const sessionButton = btn('session-button');
  const openSettingsButton = btn('open-settings');
  const statusIndicator = new SessionStatusIndicator(byId('status-indicator'));
  const statusMessage = new StatusMessage(byId('status-message'));
  const showStatus = (msg: string, isError = false) => {
    statusMessage.show(msg, isError);
  };

  // ---- Conversation timeline ----
  const conversationView = new ConversationView(
    byId('conversation'),
    byId('empty-state'),
  );
  btn('clear-chat').addEventListener('click', () => {
    conversationView.clear();
  });

  // ---- Settings modal (form + setup JSON builder) ----
  const settings = new SettingsModal(
    {
      modal: byId('settings-modal'),
      openButton: openSettingsButton,
      doneButton: btn('settings-done'),
      wsEnvironmentSelect: sel('ws-environment'),
      wsLocationSelect: sel('ws-location'),
      wsEndpointDisplay: inp('ws-endpoint-display'),
      modelInput: sel('model-id'),
      modelValueDisplay: inp('model-value'),
      voiceInput: inp('voice-name'),
      langInput: inp('language-code'),
      systemInstructionTextarea: txta('system-instruction'),
      modalityAudio: inp('modality-audio'),
      modalityText: inp('modality-text'),
      genTemperature: inp('gen-temperature'),
      genTopP: inp('gen-top-p'),
      genTopK: inp('gen-top-k'),
      genMaxTokens: inp('gen-max-tokens'),
      inputTransCheckbox: inp('input-transcription'),
      inputTransLanguageMode: sel('input-trans-language-mode'),
      inputTransLanguageCodes: inp('input-trans-language-codes'),
      outputTransCheckbox: inp('output-transcription'),
      outputTransLanguageMode: sel('output-trans-language-mode'),
      outputTransLanguageCodes: inp('output-trans-language-codes'),
      activityHandlingSelect: sel('activity-handling'),
      turnCoverageSelect: sel('turn-coverage'),
      disableAadCheckbox: inp('disable-automatic-activity-detection'),
      aadStartSensitivitySelect: sel('aad-start-sensitivity'),
      aadEndSensitivitySelect: sel('aad-end-sensitivity'),
      aadPrefixPaddingMsInput: inp('aad-prefix-padding-ms'),
      aadSilenceDurationMsInput: inp('aad-silence-duration-ms'),
      ctxCompressionCheckbox: inp('ctx-compression'),
      ctxTriggerInput: inp('ctx-trigger-tokens'),
      ctxTargetInput: inp('ctx-target-tokens'),
      proactiveAudioCheckbox: inp('proactive-audio'),
      setupOverrideTextarea: txta('setup-json-override'),
      summary: {
        endpoint: byId('kv-endpoint'),
        model: byId('kv-model'),
        voice: byId('kv-voice'),
        language: byId('kv-language'),
      },
    },
    showStatus,
    () => {
      if (modelsLoader) modelsLoader.populate();
    },
  );

  // ---- /models loader ----
  const modelsLoader = new ModelsLoader(
    sel('model-id'),
    btn('refresh-models'),
    () => {
      settings.refreshConfigSummary();
    },
    showStatus,
  );
  modelsLoader.fetch();
  // Cache the active Cloud project id; needed by the websocket backend
  // when constructing the fully-qualified model resource name. Read later
  // via projectInfo.getProjectInfo().
  projectInfo.fetchProjectInfo(showStatus).then((info) => {
    if (!info) return;
    settings.setProjectId(info.projectId);
    // Refresh once the project id is known so the model summary
    // reflects it.
    settings.refreshConfigSummary();
  });

  // ---- Session-ended toast ----
  // Briefly tells the user that the recording is available on the
  // Recordings page; replaces the older save/discard modal flow now that
  // recordings can be inspected directly via the sidebar.
  function showRecordingToast() {
    const toast = document.createElement('div');
    toast.className = 'session-toast';
    const card = document.createElement('div');
    card.className = 'session-toast-card';
    const icon = document.createElement('div');
    icon.className = 'session-toast-icon';
    icon.textContent = '\u{1F4FC}';
    const text = document.createElement('div');
    text.className = 'session-toast-text';
    text.textContent = 'Session ended.';
    const hint = document.createElement('div');
    hint.className = 'session-toast-hint';
    hint.textContent = 'View the recording on the Recordings page.';
    const refreshHint = document.createElement('div');
    refreshHint.className = 'session-toast-hint';
    refreshHint.textContent = 'Refresh the list may needed.';
    card.appendChild(icon);
    card.appendChild(text);
    card.appendChild(hint);
    card.appendChild(refreshHint);
    toast.appendChild(card);
    document.body.appendChild(toast);
    // Trigger CSS transition.
    requestAnimationFrame(() => {
      toast.classList.add('is-visible');
    });
    // Stay on screen until the user clicks or presses any key. Listeners
    // are added on the next animation frame so the click/key that opened
    // the toast (if any) doesn't immediately dismiss it.
    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      document.removeEventListener('mousedown', dismiss, true);
      document.removeEventListener('keydown', dismiss, true);
      document.removeEventListener('touchstart', dismiss, true);
      toast.classList.remove('is-visible');
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 250);
    };
    requestAnimationFrame(() => {
      document.addEventListener('mousedown', dismiss, true);
      document.addEventListener('keydown', dismiss, true);
      document.addEventListener('touchstart', dismiss, true);
    });
  }

  // ---- Session id (one per page load) ----
  const sessionId = crypto.randomUUID();
  console.log('Session ID:', sessionId);

  // ---- Audio + video controllers ----
  const playback = new PlaybackController();
  const audioSelect = sel('audio-source');
  const videoSelect = sel('video-source');

  const ws = new WebSocketClient(sessionId, playback.buffer(), showStatus, {
    onOpen: () => {
      statusIndicator.set('active');
    },
    onClose: (hadActiveSession) => {
      sessionButton.textContent = 'Start session';
      sessionButton.disabled = false;
      openSettingsButton.disabled = false;
      statusIndicator.set('idle');
      mic.stop();
      video.stopStreams();
      if (hadActiveSession) {
        // The recording is now exposed via the Recordings sidebar; just
        // surface a transient toast pointing the user there instead of
        // the old save/discard modal.
        showRecordingToast();
      }
    },
  });

  const mic = new MicCaptureController(
    () => ws.isOpen() && ws.isSessionActive(),
    (audioBytes) => {
      // The wire format expects `data` as base64-encoded bytes
      // (proto3 JSON encoding of the `bytes` field).
      ws.sendRealtime('audio', {
        mimeType: `audio/pcm;rate=${constants.AUDIO_INPUT_SAMPLE_RATE}`,
        data: bytesToBase64(audioBytes),
      });
    },
    showStatus,
  );

  const video = new VideoController(
    byId('video-display') as HTMLVideoElement,
    byId('video-empty'),
    videoSelect,
    () => ws.isOpen() && ws.isSessionActive(),
    (imageBytes) => {
      // Base64-encoded per proto3 JSON `bytes` encoding.
      ws.sendRealtime('video', {
        mimeType: 'image/jpeg',
        data: bytesToBase64(imageBytes),
      });
    },
  );
  video.populateMediaDevices(audioSelect);

  audioSelect.addEventListener('change', () => {
    mic.stop();
    if (audioSelect.value !== 'none') {
      mic.start(audioSelect.value).catch(() => {
        audioSelect.value = 'none';
      });
    }
  });

  // ---- Drain the playback queue into UI / audio output ----
  playback.startDrainLoop({
    transcription: (role, text, finished) => {
      conversationView.appendTranscription(role, text, finished);
    },
    newTranscriptionSignal: (role) => {
      conversationView.endBubbleForRole(role);
    },
    toolCall: (name, id, args) => {
      conversationView.appendToolCall(name, id, args);
    },
    toolCallCancellation: (ids) => {
      conversationView.appendToolCallCancellation(ids);
    },
    toolResponse: (name, id, response) => {
      conversationView.appendToolResponse(name, id, response);
    },
  });

  // ---- Session start/stop button ----
  sessionButton.addEventListener('click', async () => {
    sessionButton.disabled = true;

    // Reset capture selectors back to None on every transition.
    audioSelect.value = 'none';
    videoSelect.value = 'none';
    mic.stop();
    video.stopStreams();

    if (!ws.isSessionActive()) {
      try {
        let setupJson;
        try {
          setupJson = settings.buildSetupJson();
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          throw new Error(`Invalid setup JSON override: ${message}`);
        }
        openSettingsButton.disabled = true;

        // tslint:disable:enforce-name-casing wire fields use snake_case.
        const body = {
          session_id: sessionId,
          endpoint_url: settings.getEndpointUrl() || null,
          setup: setupJson,
        };
        // tslint:enable:enforce-name-casing
        const response = await fetch('/start', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }
        const result = (await response.json()) as {status: string};
        if (result.status !== 'started') {
          throw new Error('Backend did not confirm session start.');
        }

        playback.ensureContext();
        ws.connect();
        sessionButton.textContent = 'Stop session';
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to start session:', error);
        showStatus(`Failed to start session: ${message}`, true);
        statusIndicator.set('error');
        openSettingsButton.disabled = false;
      } finally {
        sessionButton.disabled = false;
      }
    } else {
      sessionButton.disabled = true;
      ws.close();
    }
  });

  // ---- Chat input ----
  const chatInput = txta('chat-input');
  const sendButton = btn('send-button');
  sendButton.addEventListener('click', () => {
    const text = chatInput.value;
    if (text && ws.isOpen()) {
      ws.sendRealtime('text', {text});
      conversationView.appendTranscription('user', text, true);
      chatInput.value = '';
    }
  });
  chatInput.addEventListener('keydown', (event) => {
    const ke = event as KeyboardEvent;
    if (ke.key === 'Enter' && !ke.shiftKey) {
      event.preventDefault();
      sendButton.click();
    }
  });

  // ---- Sidebar page switching ----
  const recordingViewer = initRecordingViewer();
  const pageChat = byId('page-chat');
  const pageRecording = byId('page-recording');
  const sidebarItems =
    document.querySelectorAll<HTMLButtonElement>('.sidebar-item');
  for (const item of sidebarItems) {
    item.addEventListener('click', () => {
      const target = item.dataset['page'];
      if (!target) return;
      for (const other of sidebarItems) {
        other.classList.toggle('is-active', other === item);
      }
      pageChat.hidden = target !== 'chat';
      pageRecording.hidden = target !== 'recording';
      // Refresh the recordings list every time the user enters the
      // Recordings page so new recordings appear without an explicit
      // refresh click.
      if (target === 'recording') {
        void recordingViewer.refreshList();
      }
    });
  }
});
