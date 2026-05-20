/**
 * @fileoverview Renders the conversation timeline: incremental transcription
 * bubbles for user/model, plus distinct bubbles for tool calls, tool call
 * cancellations, and tool responses.
 */

/** Renders the chat timeline (transcription + tool bubbles). */
export class ConversationView {
  private currentBubbles: {[role: string]: HTMLElement | null} = {};

  /**
   * @param conversation Scroll container for bubbles.
   * @param emptyState Placeholder shown when no bubbles yet.
   */
  constructor(
    private readonly conversation: HTMLElement,
    private readonly emptyState: HTMLElement | null,
  ) {}

  /** Removes the empty-state placeholder if it's still in the DOM. */
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

  /**
   * Resets the "current" bubble for a role so the next text starts a new one.
   */
  endBubbleForRole(role: string) {
    this.currentBubbles[role] = null;
  }

  /**
   * Appends incremental transcription text to the active bubble for `role`.
   * Creates the bubble lazily on first text.
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
      bubble.querySelector('.bubble-text')!.textContent += text;
      this.scrollToBottom();
    }
    if (finished) this.currentBubbles[role] = null;
  }

  /**
   * Renders a tool_call or tool_response bubble. Both share the same look so
   * we use one helper parameterized by label and CSS modifier.
   */
  private appendToolEntry(
    label: string,
    modifierClass: string | null,
    name: string,
    id: string | null,
    payload: unknown,
  ) {
    this.ensureEmptyStateHidden();
    const bubble = document.createElement('div');
    bubble.classList.add('bubble', 'bubble-tool');
    if (modifierClass) bubble.classList.add(modifierClass);

    const header = document.createElement('div');
    header.classList.add('tool-header');
    const labelEl = document.createElement('span');
    labelEl.classList.add('tool-label');
    labelEl.textContent = label;
    header.appendChild(labelEl);
    if (name !== null) {
      const nameEl = document.createElement('span');
      nameEl.classList.add('tool-name');
      nameEl.textContent = name || '(unnamed)';
      header.appendChild(nameEl);
    }
    if (id) {
      const idEl = document.createElement('span');
      idEl.classList.add('tool-id');
      idEl.textContent = `id=${id}`;
      header.appendChild(idEl);
    }
    bubble.appendChild(header);

    if (payload !== null && payload !== undefined) {
      const pre = document.createElement('pre');
      pre.classList.add('tool-args');
      try {
        pre.textContent = JSON.stringify(payload, null, 2);
      } catch {
        pre.textContent = String(payload);
      }
      bubble.appendChild(pre);
    }

    this.conversation.appendChild(bubble);
    this.scrollToBottom();
  }

  /** Appends a tool-call bubble (model invokes a tool). */
  appendToolCall(name: string, id: string | null, args: unknown) {
    this.appendToolEntry('tool call', null, name, id, args);
  }

  /** Appends a tool-response bubble (result returned to the model). */
  appendToolResponse(name: string, id: string | null, response: unknown) {
    this.appendToolEntry(
      'tool response',
      'bubble-tool-response',
      name,
      id,
      response,
    );
  }

  /** Appends a tool-call cancellation bubble. */
  appendToolCallCancellation(ids: string[]) {
    this.ensureEmptyStateHidden();
    const bubble = document.createElement('div');
    bubble.classList.add('bubble', 'bubble-tool', 'bubble-tool-cancel');
    const header = document.createElement('div');
    header.classList.add('tool-header');
    const label = document.createElement('span');
    label.classList.add('tool-label');
    label.textContent = 'tool cancelled';
    header.appendChild(label);
    if (ids && ids.length) {
      const idEl = document.createElement('span');
      idEl.classList.add('tool-id');
      idEl.textContent = `ids=${ids.join(', ')}`;
      header.appendChild(idEl);
    }
    bubble.appendChild(header);
    this.conversation.appendChild(bubble);
    this.scrollToBottom();
  }
}
