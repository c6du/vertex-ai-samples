/**
 * @fileoverview Top-of-page status indicator (idle / active / error) and the
 * transient toast-style status messages shown in the video panel header.
 */

/** Shows the lifecycle state of the live session. */
export class SessionStatusIndicator {
  private readonly dot: HTMLElement;
  private readonly label: HTMLElement;

  /** @param container Element with .status-dot/.status-label. */
  constructor(container: HTMLElement) {
    this.dot = container.querySelector('.status-dot') as HTMLElement;
    this.label = container.querySelector('.status-label') as HTMLElement;
    this.set('idle');
  }

  /** @param state One of 'idle', 'active', 'error'. */
  set(state: string) {
    this.dot.classList.remove('status-idle', 'status-active', 'status-error');
    if (state === 'active') {
      this.dot.classList.add('status-active');
      this.label.textContent = 'Session active';
    } else if (state === 'error') {
      this.dot.classList.add('status-error');
      this.label.textContent = 'Error';
    } else {
      this.dot.classList.add('status-idle');
      this.label.textContent = 'Idle';
    }
  }
}

/** Auto-clearing toast for short success/error notifications. */
export class StatusMessage {
  private timeoutId = 0;

  constructor(private readonly el: HTMLElement) {}

  /** Shows a toast for ~5 s, replacing any currently-visible message. */
  show(message: string, isError = false) {
    this.el.textContent = message;
    this.el.className = 'status-message visible';
    this.el.classList.add(isError ? 'error' : 'success');
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.timeoutId = setTimeout(() => {
      this.el.textContent = '';
      this.el.className = 'status-message';
    }, 5000);
  }
}
