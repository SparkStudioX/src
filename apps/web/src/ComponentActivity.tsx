import { createContext, useContext } from "react";
import type { ReactNode } from "react";

const ComponentActivity = createContext(true);
/** Retained hidden container panes keep their form state but lose event authority. */
export function ComponentActivityProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const parentActive = useContext(ComponentActivity);
  return <ComponentActivity.Provider value={parentActive && active}>{children}</ComponentActivity.Provider>;
}
export function useComponentActivity() { return useContext(ComponentActivity); }
