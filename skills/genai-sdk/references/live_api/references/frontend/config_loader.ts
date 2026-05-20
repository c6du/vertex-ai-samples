/**
 * @fileoverview Loads the list of models exposed by the server (GET /models)
 * and renders them in the model <select>.
 */

interface ModelEntry {
  name: string;
  value: string;
}

/** Loads /models and populates the model dropdown. */
export class ModelsLoader {
  private models: ModelEntry[] = [];

  /**
   * @param onChange Called after the dropdown changes (e.g. to refresh the
   *     sidebar summary).
   */
  constructor(
    private readonly modelInput: HTMLSelectElement,
    private readonly refreshButton: HTMLButtonElement,
    private readonly onChange: () => void,
    private readonly showStatus: (msg: string, isError?: boolean) => void,
  ) {
    this.refreshButton.addEventListener('click', () => {
      this.fetch();
    });
  }

  /** Fetches /models then repopulates the dropdown. */
  async fetch() {
    this.refreshButton.disabled = true;
    try {
      const response = await fetch('/models', {cache: 'no-store'});
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      const result = (await response.json()) as {models: ModelEntry[]};
      this.models = result.models || [];
      this.populate();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('Failed to load models config:', e);
      this.showStatus(`Failed to load models: ${message}`, true);
    } finally {
      this.refreshButton.disabled = false;
    }
  }

  /** Repopulates the model <select>. */
  populate() {
    const previous = this.modelInput.value;
    this.modelInput.replaceChildren();
    for (const entry of this.models) {
      const opt = document.createElement('option');
      opt.value = entry.value;
      opt.textContent = entry.name;
      this.modelInput.appendChild(opt);
    }
    // Preserve the previous selection if still valid; otherwise default to
    // the first option (the YAML lists models in priority order).
    const values = this.models.map((m) => m.value);
    if (previous && values.includes(previous)) {
      this.modelInput.value = previous;
    } else if (values.length > 0) {
      this.modelInput.value = values[0];
    } else {
      this.modelInput.value = '';
    }
    this.onChange();
  }
}
