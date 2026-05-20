/**
 * Renders the conversation timeline: incremental transcription bubbles for
 * user/model.
 *
 * Tool-call rendering is intentionally absent in this reference build: the
 * public release does not configure tools on the model, so the model will
 * not emit `toolCall` / `toolCallCancellation` frames. If you add tools,
 * port the `appendToolCall*` helpers back from the internal app.
 */

/** Renders the chat timeline (transcription bubbles only). */
export class ConversationView {
  private currentBubbles: {[role: string]: HTMLElement | null} = {};

  constructor(
    private readonly conversation: HTMLElement,
    private readonly emptyState: HTMLElement | null,
  ) {}

  private ensureEmptyStateHidden() {
    if (
      this.emptyState &&
      this.emptyState.parentElement === this.conversation
    ) {
      this.conversation.removeChild(this.emptyState);
    }
  }

  private scrollToBottom() {
    this.conversation.scrollTop = this.conversation.scrollHeight;
  }

  /** Wipes the timeline and re-attaches the empty-state placeholder. */
  clear() {
    this.conversation.replaceChildren();
    this.currentBubbles = {};
    if (this.emptyState) this.conversation.appendChild(this.emptyState);
  }

  /** Resets the "current" bubble for a role so the next text starts a new one. */
  endBubbleForRole(role: string) {
    this.currentBubbles[role] = null;
  }

  /**
   * Appends incremental transcription text to the active bubble for `role`.
   * Creates the bubble lazily on first text.
   *
   * @param role 'user' or 'model'.
   * @param finished If true, ends the bubble after appending.
   */
  appendTranscription(role: string, text: string, finished: boolean) {
    if (!text && !finished) return;
    if (text) {
      this.ensureEmptyStateHidden();
      let bubble = this.currentBubbles[role];
      if (!bubble) {
        bubble = document.createElement('div');
        bubble.classList.add('bubble');
        bubble.classList.add(role === 'user' ? 'bubble-user' : 'bubble-model');

        const roleSpan = document.createElement('span');
        roleSpan.classList.add('bubble-role');
        roleSpan.textContent = role;
        bubble.appendChild(roleSpan);

        const textSpan = document.createElement('span');
        textSpan.classList.add('bubble-text');
        bubble.appendChild(textSpan);

        this.conversation.appendChild(bubble);
        this.currentBubbles[role] = bubble;
      }
      const textEl = bubble.querySelector('.bubble-text');
      if (textEl) textEl.textContent = (textEl.textContent ?? '') + text;
      this.scrollToBottom();
    }
    if (finished) this.currentBubbles[role] = null;
  }
}
