import { useEffect, useState } from "react";
import TagModels from "./TagModels";
import { modelDraftEvent, takeModelDraft, type ModelDraft } from "./modelWorkspace";
import type { Connection, Tag } from "./types";

/** All entry points share one model editor and the same owner-scoped draft. */
export default function ModelsWorkspace({ ownerId, connections = [], tags, onApplied }: { ownerId: string; connections?: Connection[]; tags?: Tag[]; onApplied: () => void }) {
  const [initialDraft, setInitialDraft] = useState<ModelDraft>();
  useEffect(() => {
    const receive = () => { const draft = takeModelDraft(ownerId); if (draft) setInitialDraft(draft); };
    receive(); window.addEventListener(modelDraftEvent, receive);
    return () => window.removeEventListener(modelDraftEvent, receive);
  }, [ownerId]);
  return <TagModels ownerId={ownerId} connections={connections} tags={tags} initialDraft={initialDraft} onApplied={onApplied} />;
}
