import { createContext, useContext } from "react";
import type { PropsWithChildren } from "react";
import type { VisualStyle } from "./types";

const context = createContext<VisualStyle[] | undefined>(undefined);
export function VisualStyleProvider({ styles, children }: PropsWithChildren<{ styles?: VisualStyle[] }>) {
  return <context.Provider value={styles}>{children}</context.Provider>;
}
export function useVisualStyles() { return useContext(context); }
