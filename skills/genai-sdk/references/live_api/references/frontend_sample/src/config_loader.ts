/**
 * Loads the model list (GET /models) and populates the model dropdown.
 *
 * MCP support is intentionally absent in this reference build.
 */

interface ModelEntry {
  name: string;
  value: string;
}

/** Loads /models and populates the model dropdown. */
export class ModelsLoader {
  private models: ModelEntry[] = [];

  constructor(
    private readonly modelInput: HTMLSelectElement,
    private readonly refreshButton: HTMLButtonElement,
    private readonly onChange: () => void,
    private readonly showStatus: (msg: string, isError?: boolean) => void,
  ) {
    this.refreshButton.addEventListener('click', () => {
      void this.fetch();
    });
  }

  /** Fetches /models then repopulates the dropdown. */
  async fetch(): Promise<void> {
    this.refreshButton.disabled = true;
    try {
      const response = await fetch('/models', {cache: 'no-store'});
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      // Server returns `{models: {websocket: [{name, value}, ...]}}`. We
      // only support the websocket backend in this reference build so we
      // pluck that one entry. (Kept as a wrapper map so the server can be
      // shared with multi-backend variants in the future.)
      const result = (await response.json()) as {
        models: {[backend: string]: ModelEntry[]};
      };
      this.models = result.models?.['websocket'] ?? [];
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
