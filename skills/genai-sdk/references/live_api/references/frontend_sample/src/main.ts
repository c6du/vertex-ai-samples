/**
 * Entry point for the Live API reference playground. Looks up DOM elements,
 * instantiates the controllers from sibling modules, and wires together the
 * session start/stop flow plus the chat-input handler.
 *
 * Heavy lifting lives in:
 *   - settings_modal.ts:   form + setup JSON builder
 *   - config_loader.ts:    /models loader
 *   - audio.ts / video.ts: capture + playback controllers
 *   - websocket_client.ts: protocol bridge to the local proxy server
 *   - conversation_view.ts: bubble rendering
 *   - status_view.ts:      indicator + transient toasts
 *   - recording_viewer.ts: recordings page
 */

import {MicCaptureController, PlaybackController} from './audio.js';
import {ModelsLoader} from './config_loader.js';
import * as constants from './constants.js';
import {ConversationView} from './conversation_view.js';
import * as projectInfo from './project_info.js';
import {initRecordingViewer} from './recording_viewer.js';
import {SettingsModal} from './settings_modal.js';
import {SessionStatusIndicator, StatusMessage} from './status_view.js';
import {VideoController} from './video.js';
import {WebSocketClient} from './websocket_client.js';

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
  btn('clear-chat').addEventListener('click', () => conversationView.clear());

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
      outputTransCheckbox: inp('output-transcription'),
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
      setupOverrideTextarea: txta('setup-json-override'),
      summary: {
        endpoint: byId('kv-endpoint'),
        model: byId('kv-model'),
        voice: byId('kv-voice'),
        language: byId('kv-language'),
      },
    },
    showStatus,
  );

  // ---- /models loader ----
  const modelsLoader = new ModelsLoader(
    sel('model-id'),
    btn('refresh-models'),
    () => settings.refreshConfigSummary(),
    showStatus,
  );
  void modelsLoader.fetch();

  // Cache the Cloud project id (needed to build the full model resource name).
  void projectInfo.fetchProjectInfo(showStatus).then((info) => {
    if (!info) return;
    settings.setProjectId(info.projectId);
  });

  // ---- Session id (one per page load) ----
  const sessionId = crypto.randomUUID();
  console.log('Session ID:', sessionId);

  // ---- Audio + video controllers ----
  const playback = new PlaybackController();
  const audioSelect = sel('audio-source');
  const videoSelect = sel('video-source');

  const ws = new WebSocketClient(sessionId, playback.buffer(), showStatus, {
    onOpen: () => statusIndicator.set('active'),
    onClose: (hadActiveSession) => {
      sessionButton.textContent = 'Start session';
      sessionButton.disabled = false;
      openSettingsButton.disabled = false;
      statusIndicator.set('idle');
      mic.stop();
      video.stopStreams();
      if (hadActiveSession) {
        showStatus(
          'Session ended. The recording is available on the Recordings page.',
        );
      }
    },
  });

  const mic = new MicCaptureController(
    () => ws.isOpen() && ws.isSessionActive(),
    (audioBytes) => {
      ws.sendRealtime({
        kind: 'audio',
        mimeType: `audio/pcm;rate=${constants.AUDIO_INPUT_SAMPLE_RATE}`,
        data: audioBytes,
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
      ws.sendRealtime({kind: 'video', mimeType: 'image/jpeg', data: imageBytes});
    },
  );
  void video.populateMediaDevices(audioSelect);

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
  });

  // ---- Session start/stop button ----
  sessionButton.addEventListener('click', async () => {
    sessionButton.disabled = true;

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

        const body = {
          session_id: sessionId,
          endpoint_url: settings.getEndpointUrl(),
          setup: setupJson,
        };
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

  // ---- Chat input (text via clientContent on /ws) ----
  const chatInput = txta('chat-input');
  const sendButton = btn('send-button');
  sendButton.addEventListener('click', () => {
    const text = chatInput.value;
    if (text && ws.isOpen()) {
      ws.sendRealtime({kind: 'text', text});
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
      if (target === 'recording') {
        void recordingViewer.refreshList();
      }
    });
  }
});
