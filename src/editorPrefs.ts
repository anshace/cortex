// Editor preferences, persisted in localStorage and shared live between the
// Settings panel and every open editor (use-local-storage-state syncs hook
// instances within the tab).
import useLocalStorageState from "use-local-storage-state";

export type EditorPrefs = {
  fontSize: number;
  minimap: boolean;
  wordWrap: boolean;
  lineNumbers: boolean;
  bracketPairs: boolean;
  stickyScroll: boolean;
  showStats: boolean;
};

export const DEFAULT_PREFS: EditorPrefs = {
  fontSize: 13,
  minimap: true,
  wordWrap: true,
  lineNumbers: true,
  bracketPairs: true,
  stickyScroll: false,
  showStats: true,
};

export function useEditorPrefs(): [EditorPrefs, (p: EditorPrefs) => void] {
  const [v, setV] = useLocalStorageState<EditorPrefs>("cortex-editor-prefs", {
    defaultValue: DEFAULT_PREFS,
  });
  // Merge so a newly-added pref falls back to its default for old stored blobs.
  return [{ ...DEFAULT_PREFS, ...v }, setV];
}
