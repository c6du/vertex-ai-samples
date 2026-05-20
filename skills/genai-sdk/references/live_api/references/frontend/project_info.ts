/**
 * @fileoverview Loads the active Cloud project id from the server
 * (GET /project_info) once at startup and caches the result. The value
 * is needed when constructing the fully-qualified model resource name
 * for the WebSocket backend.
 */

/** Project metadata returned by the `/project_info` server endpoint. */
export interface ProjectInfo {
  projectId: string;
}

/** Wire format returned by the `/project_info` HTTP endpoint. */
interface ProjectInfoResponse {
  // tslint:disable-next-line:enforce-name-casing wire field
  project_id: string;
}

let cached: ProjectInfo | null = null;

/**
 * Fetches /project_info and caches the result. Subsequent calls return the
 * cached value without re-fetching. Returns `null` if the fetch fails so
 * callers can decide whether to fall back to a hard-coded value.
 */
export async function fetchProjectInfo(
  showStatus: (msg: string, isError?: boolean) => void,
): Promise<ProjectInfo | null> {
  if (cached) return cached;
  try {
    const response = await fetch('/project_info', {cache: 'no-store'});
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    const wire = (await response.json()) as ProjectInfoResponse;
    cached = {projectId: wire.project_id};
    return cached;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Failed to load project info:', e);
    showStatus(`Failed to load project info: ${message}`, true);
    return null;
  }
}

/**
 * Returns the cached project info if it has been fetched, or `null`.
 */
export function getProjectInfo(): ProjectInfo | null {
  return cached;
}
