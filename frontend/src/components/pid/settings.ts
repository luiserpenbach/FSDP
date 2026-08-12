/** Editor view settings shared with canvas node components. */
import { createContext } from "react";

export type LabelMode = "tag" | "name";

export type EditorSettings = {
  /** What symbol captions show: the component tag (default) or the node name. */
  labelMode: LabelMode;
};

export const EditorSettingsContext = createContext<EditorSettings>({ labelMode: "tag" });
