/**
 * @fileoverview Camera/screen capture and periodic JPEG frame upload. The
 * controller owns the <video> element's MediaStream lifecycle plus a hidden
 * canvas used for downscaling frames before they're sent.
 */

import * as constants from './constants';

/** Owns the <video> element's MediaStream and the JPEG-frame uploader. */
export class VideoController {
  private readonly canvas: HTMLCanvasElement = document.createElement('canvas');
  private localStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private frameIntervalId = 0;

  /**
   * @param videoEmpty Placeholder shown when no stream.
   * @param videoSelect The device picker.
   * @param canSend Returns true while it's safe to send.
   * @param sendFrame Forwards a JPEG payload.
   */
  constructor(
    private readonly videoElement: HTMLVideoElement,
    private readonly videoEmpty: HTMLElement,
    private readonly videoSelect: HTMLSelectElement,
    private readonly canSend: () => boolean,
    private readonly sendFrame: (imageBytes: Uint8Array) => void,
  ) {
    this.videoSelect.addEventListener('change', () => {
      this.onSelect();
    });
  }

  /**
   * Populates the audio/video device <select>s. We must call getUserMedia
   * once first so device labels are available.
   */
  async populateMediaDevices(audioSelect: HTMLSelectElement) {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const makeNoneOption = () => {
      const o = document.createElement('option');
      o.value = 'none';
      o.text = 'None';
      return o;
    };
    const screenOption = () => {
      const o = document.createElement('option');
      o.value = 'screen';
      o.text = 'Screen sharing';
      return o;
    };
    try {
      await navigator.mediaDevices.getUserMedia({audio: true, video: true});
      const devices = await navigator.mediaDevices.enumerateDevices();
      audioSelect.replaceChildren(makeNoneOption());
      this.videoSelect.replaceChildren(makeNoneOption());
      for (const device of devices) {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.text =
          device.label || `Device ${device.deviceId.substring(0, 8)}`;
        if (device.kind === 'audioinput') {
          audioSelect.appendChild(option);
        } else if (device.kind === 'videoinput') {
          this.videoSelect.appendChild(option);
        }
      }
      this.videoSelect.appendChild(screenOption());
    } catch (err) {
      console.error('Error populating devices:', err);
      this.videoSelect.appendChild(screenOption());
    }
  }

  private async onSelect() {
    const value = this.videoSelect.value;
    this.stopStreams();
    if (value === 'screen') {
      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
        });
        this.videoElement.srcObject = this.screenStream;
        this.videoEmpty.hidden = true;
        this.startFrameCapture();
        for (const track of this.screenStream.getTracks()) {
          track.onended = () => {
            if (this.videoSelect.value === 'screen') {
              this.videoSelect.value = 'none';
              this.stopStreams();
            }
          };
        }
      } catch (err) {
        console.error('Screen sharing failed:', err);
        this.videoSelect.value = 'none';
      }
    } else if (value !== 'none') {
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          video: {deviceId: {exact: value}},
        });
        this.videoElement.srcObject = this.localStream;
        this.videoEmpty.hidden = true;
        this.startFrameCapture();
      } catch (err) {
        console.error('Failed to get camera stream:', err);
        this.videoSelect.value = 'none';
      }
    }
  }

  /** Halts any active local/screen MediaStream and stops the frame timer. */
  stopStreams() {
    this.stopFrameCapture();
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) {
        t.stop();
      }
      this.localStream = null;
    }
    if (this.screenStream) {
      for (const t of this.screenStream.getTracks()) {
        t.stop();
      }
      this.screenStream = null;
    }
    this.videoElement.srcObject = null;
    this.videoEmpty.hidden = false;
  }

  private startFrameCapture() {
    this.stopFrameCapture();
    this.frameIntervalId = setInterval(() => {
      this.captureFrame();
    }, constants.VIDEO_FRAME_INTERVAL_MS);
  }

  private stopFrameCapture() {
    if (this.frameIntervalId) {
      clearInterval(this.frameIntervalId);
      this.frameIntervalId = 0;
    }
  }

  private async captureFrame() {
    if (
      !this.canSend() ||
      !this.videoElement.srcObject ||
      this.videoElement.paused ||
      this.videoElement.ended ||
      this.videoElement.videoWidth === 0
    ) {
      return;
    }
    const w = this.videoElement.videoWidth;
    const h = this.videoElement.videoHeight;
    const ratio = w / h;
    let tw;
    let th;
    if (w >= h) {
      tw = constants.VIDEO_MAX_DIMENSION;
      th = constants.VIDEO_MAX_DIMENSION / ratio;
    } else {
      th = constants.VIDEO_MAX_DIMENSION;
      tw = constants.VIDEO_MAX_DIMENSION * ratio;
    }
    this.canvas.width = Math.round(tw);
    this.canvas.height = Math.round(th);
    const ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    ctx.drawImage(
      this.videoElement,
      0,
      0,
      this.canvas.width,
      this.canvas.height,
    );
    this.canvas.toBlob(
      async (blob) => {
        if (blob && this.canSend()) {
          const imageBytes = new Uint8Array(await blob.arrayBuffer());
          this.sendFrame(imageBytes);
        }
      },
      'image/jpeg',
      1,
    );
  }
}
